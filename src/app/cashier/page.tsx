import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import {
  arState,
  AR_EMOJI,
  formatInvoiceNo,
  isPartiallyPaid,
  ACCOUNTS,
} from "@/lib/billing";
import {
  sendInvoiceToCustomerAction,
  recordPaymentAction,
} from "@/app/actions/billing";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import type { MessageKey } from "@/i18n/config";
import { friendlyStatus, type JobStatus } from "@/lib/jobcard-status";
import { FriendlyStatusBadge } from "@/components/friendly-status-badge";
import { JobNumberBadge } from "@/components/job-number-badge";
import { JobTimings } from "@/components/job-timings";
import { CashierFilterBar } from "@/components/cashier-filter-bar";
import { BadgeLink } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { CashierTabs } from "@/components/cashier-tabs";
import { Paginator } from "@/components/paginator";
import { PER_PAGE_OPTIONS, computeWindow } from "@/lib/pagination";

export const dynamic ="force-dynamic";

// AR outstanding + a few other cashier tiles can round to a tiny
// negative from floating-point drift and render as "AED -0.00". Snap
// values within a sub-fils band around zero to positive zero, and
// use a unicode minus OUTSIDE the currency prefix for real negatives
// (user convention: "−AED 12.50", not "AED -12.50"). The other 11
// `money` helper copies across src/app carry the same latent defect
// — filed as a separate extract-to-shared-helper follow-up.
const money = (n: number) => {
    const snapped = Math.abs(n) < 0.005 ? 0 : n;
    return snapped < 0
        ? `−AED ${(-snapped).toFixed(2)}`
        : `AED ${snapped.toFixed(2)}`;
};

// ── Filter-row attribute helpers ─────────────────────────────────
// Each row on the cashier dashboard renders with data-search +
// data-date so the CashierFilterBar (client component) can hide
// non-matching rows entirely in the DOM. Per spec the search
// should match invoice no., job no., plate, customer name — so
// concatenate all of those, lowercased, into one search string.
// Single source of truth for both /cashier and /cashier/paid.

interface JobRowLike {
  number: number | null;
  createdAt: Date;
  vehicle: {
    plate: string;
    make: string;
    model: string;
    customer: { name: string };
  };
}

function jobSearchTokens(j: JobRowLike): string {
  return [
    j.vehicle.plate,
    j.vehicle.customer.name,
    j.vehicle.make,
    j.vehicle.model,
    `#${j.number ?? ""}`,
  ]
    .join("")
    .toLowerCase();
}

function jobDateIso(j: JobRowLike): string {
  return j.createdAt.toISOString().slice(0, 10);
}

interface InvoiceRowLike {
  number: number;
  issuedAt: Date;
  jobCard: {
    number: number | null;
    vehicle: {
      plate: string;
      make: string;
      model: string;
      customer: { name: string };
    };
  };
}

function invoiceSearchTokens(inv: InvoiceRowLike): string {
  return [
    formatInvoiceNo(inv.number, inv.issuedAt.getFullYear()),
    inv.jobCard.vehicle.plate,
    inv.jobCard.vehicle.customer.name,
    inv.jobCard.vehicle.make,
    inv.jobCard.vehicle.model,
    `#${inv.jobCard.number ?? ""}`,
  ]
    .join("")
    .toLowerCase();
}

function invoiceDateIso(inv: InvoiceRowLike): string {
  return inv.issuedAt.toISOString().slice(0, 10);
}

// Visual polish C2: shared button class strings used by the section
// action rows below. Keeps every dashboard action consistent with the
// Workshop design system. /cashier is an overview, so it has NO hero
// (amber) action — every section action is `primary`. Hero is
// reserved for focused detail pages where one action dominates.
const BTN_PRIMARY_MD =
"inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";
const BTN_GHOST_SM =
"inline-flex h-8 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-xs font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";

// Permitted tab values; anything else falls back to 'estimates'.
const VALID_TABS = new Set<string>([
"estimates",
"invoices",
"payments",
"reports",
]);

// Permitted Estimates-tab filter values. The cashier dashboard counters
// hand off via /cashier?tab=estimates&filter=<one of these>, which the
// page narrows to just the matching section. Anything not in this set
// is treated as 'no filter' (silently — never throw on a bad URL).
type EstimateFilter =
  |"pending_estimates"
  |"pending_approval"
  |"approved"
  |"rejected"
  |"revised";
const VALID_ESTIMATE_FILTERS = new Set<EstimateFilter>([
"pending_estimates",
"pending_approval",
"approved",
"rejected",
"revised",
]);

// Permitted Invoices-tab filter values. Mirrors the estimates pattern
// above — the dashboard counters for Ready-for-Invoice, Unpaid,
// Partially-Paid and Overdue all link to
// /cashier?tab=invoices&filter=<one of these>, and the page narrows
// the Invoices tab to just the matching section + row state.
//   ready          → Section: Awaiting final invoice (TECH_COMPLETE jobs)
//   unpaid         → Section: Receivables, all rows (DUE + PARTIAL + OVERDUE)
//   partially_paid → Section: Receivables, rows where arState === PARTIAL
//   overdue        → Section: Receivables, rows where arState === OVERDUE
// Anything not in this set is silently treated as 'no filter'.
type InvoiceFilter =
  | "ready"
  | "unpaid"
  | "partially_paid"
  | "overdue";
const VALID_INVOICE_FILTERS = new Set<InvoiceFilter>([
  "ready",
  "unpaid",
  "partially_paid",
  "overdue",
]);

export default async function CashierHome({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    filter?: string;
    // Payments-tab pagination. Estimates + Invoices tabs are NOT yet
    // paginated — see TODO(pagination) markers below. Only the Payments
    // section reads these two params.
    page?: string;
    per?: string;
  }>;
}) {
  const session = await requireAnyRole(["CASHIER", "OWNER", "MASTER"]);
  const t = await getT();
  const garageId = session.user.garageId;

  // URL-driven tabs. Default = 'estimates' so refreshing the canonical
  // /cashier URL always lands on the working tab.
  const { tab: rawTab, filter: rawFilter, page: rawPage, per: rawPer } = await searchParams;
  const currentTab = (
    rawTab && VALID_TABS.has(rawTab) ? rawTab :"estimates"
  ) as"estimates"|"invoices"|"payments"|"reports";
  // Estimate-section filter — narrows the Estimates tab to a single
  // section so a counter tap actually feels like a drill-down. Only
  // honoured when currentTab === 'estimates'; on other tabs the value
  // is read but ignored.
  const estimateFilter: EstimateFilter | null =
    rawFilter && VALID_ESTIMATE_FILTERS.has(rawFilter as EstimateFilter)
      ? (rawFilter as EstimateFilter)
      : null;
  // Predicate the JSX uses per-section. With no filter, every section
  // renders (as before). With a filter, only the matching section
  // passes — others return null. Centralising it here means the row of
  // <section> blocks below stays declarative.
  const showSection = (f: EstimateFilter): boolean =>
    estimateFilter === null || estimateFilter === f;

  // Invoices-tab counterpart. Same shape as estimateFilter — read from
  // the same ?filter= query param but only honoured when currentTab
  // === 'invoices', so the two filter namespaces don't collide.
  const invoiceFilter: InvoiceFilter | null =
    currentTab === "invoices" &&
    rawFilter &&
    VALID_INVOICE_FILTERS.has(rawFilter as InvoiceFilter)
      ? (rawFilter as InvoiceFilter)
      : null;
  // Predicate for each Invoices-tab section. Maps each counter-driven
  // filter to the section(s) it should reveal:
  //   - 'ready'      → "Awaiting final invoice" only
  //   - 'unpaid' / 'partially_paid' / 'overdue' → Receivables only
  // With no filter, every section renders as before. Row-level
  // filtering for the Receivables list happens inline below.
  const showInvoiceSection = (
    section: "to_send" | "to_invoice" | "receivables",
  ): boolean => {
    if (invoiceFilter === null) return true;
    if (section === "to_invoice") return invoiceFilter === "ready";
    if (section === "receivables")
      return (
        invoiceFilter === "unpaid" ||
        invoiceFilter === "partially_paid" ||
        invoiceFilter === "overdue"
      );
    // to_send (Stage 8 INVOICED-not-yet-sent) isn't backed by a counter
    // — hide it during any filter drill-down to keep the page focused.
    return false;
  };

  const locale = await getLocale();
  // One small side-query for the garage's country so every display
  // date renders in Asia/Dubai (etc.) rather than UTC. The cashier
  // dashboard is per-garage, so it's a single row lookup — no widening
  // of the invoice/ledger/job finds.
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { country: true },
  });
  const tz = countryToTimeZone(garage?.country ?? "UAE");
  const [invoices, ledger, jobs] = await Promise.all([
    prisma.invoice.findMany({
      // Exclude VOIDed rows from the dashboard's active receivables
      // + counter math. A voided invoice keeps its number for audit
      // (visible on /invoices/[id] directly) but doesn't count as
      // money owed. Correction invoices land here under the new
      // number they took at reissue time.
      where: { garageId, status: { not: "VOID" } },
      include: { payments: true, jobCard: { include: { vehicle: { include: { customer: true } } } } },
      orderBy: { issuedAt:"desc"},
    }),
    prisma.ledgerEntry.findMany({ where: { garageId } }),
    // Active jobs that need cashier attention at some point in the
    // lifecycle. We INCLUDE the INVOICED status now — once the invoice
    // is created the cashier still has to tap 'Send Invoice to Customer'
    // from the dashboard, so unsent invoices need to surface here. We
    // drop INVOICED+sent jobs in JS (they live in Receivables only).
    prisma.jobCard.findMany({
      where: { garageId, status: { notIn: ["DELIVERED","CANCELLED"] } },
      include: {
        vehicle: { include: { customer: true } },
        // Latest estimate drives the friendly status (SENT → 'Awaiting customer
        // approval', else 'Estimate under process'). Pulled WITHOUT `take`
        // because the Approved row also needs to find the APPROVED
        // sibling for routing — if a stray empty DRAFT exists alongside
        // an APPROVED one (the double-tap race), the 'Generate Invoice'
        // link must land on the APPROVED estimate's id, not the
        // most-recent (empty) one. Most jobs have 1-3 estimates max so
        // dropping `take: 1` is cheap.
        estimates: {
          orderBy: { createdAt:"desc"},
          // `total` added for the Approved/Rejected estimate rows that
          // show 'AED <total>' beside the status badge so the cashier
          // sees pipeline value without clicking in.
          select: { id: true, status: true, sentAt: true, total: true },
        },
        // Latest invoice id — needed to target sendInvoiceToCustomerAction
        // from the dashboard's 'Send Invoice to Customer' button.
        invoices: {
          orderBy: { issuedAt:"desc"},
          take: 1,
          select: { id: true, number: true, total: true },
        },
      },
      orderBy: [
        // Cars freshly handed off (status=ESTIMATE) bubble to the top so
        // the cashier sees them first.
        { status:"asc"},
        { createdAt:"desc"},
      ],
    }),
    // (Counters used to depend on a separate Estimate.groupBy round
    // trip; they're now derived from `jobs` below — keeps counter ==
    // section count by construction and saves a query.)
  ]);

  // Cashier dashboard buckets — each surfaces a different"what's mine to
  // do now"question. Estimate-state buckets (pendingEstimateJobs etc)
  // are below; the non-counter buckets here drive the Invoices tab.
  //
  //  waitingForDiagnosis — tech is still working on it; cashier can SEE
  //   the job exists but has no actions yet. No buttons rendered.
  //  toInvoice     — tech marked complete; cashier needs to PREPARE
  //            the invoice (edit lines + finalize). Button
  //            takes them to the estimate review page.
  //  toSendInvoice   — invoice has been prepared (status=INVOICED) but
  //            hasn't been sent yet (invoiceSentAt is null).
  //            'Send Invoice to Customer' button fires
  //            sendInvoiceToCustomerAction directly from the
  //            dashboard so the cashier doesn't need to dive
  //            into the invoice page.
  const waitingForDiagnosis = jobs.filter(
    (j) => j.status ==="ARRIVED"|| j.status ==="INSPECTION",
  );
  const toInvoice = jobs.filter((j) => j.status ==="TECH_COMPLETE");
  const toSendInvoice = jobs.filter(
    (j) => j.status ==="INVOICED"&& j.invoiceSentAt === null,
  );
  // ── Estimate-state buckets — every counter is derived from one of
  // these, AND so is the matching section's row list. Counter ==
  // section count by construction (no separate query that could drift).
  //
  //  pendingEstimateJobs  — ESTIMATE jobStatus + (no estimate || DRAFT)
  //              (Pending Estimates counter,"Jobs to price")
  //  awaitingApprovalJobs  — latest estimate SENT
  //              (Pending Approval counter,"Awaiting customer approval")
  //  approvedEstimateJobs  — latest estimate APPROVED, no invoice yet
  //              (Approved counter,"Approved estimates")
  //  rejectedEstimateJobs  — latest estimate REJECTED
  //              (Rejected counter,"Rejected estimates")
  //  revisedEstimateJobs  — re-estimate cycle (extra work found mid-job)
  //              (no separate counter; appears as"Revised
  //               estimates"section)
  //
  // REJECTED was previously folded into 'Jobs to price' as a re-price
  // branch; it's now its own section so the Rejected counter has a
  // landing place and the re-price action is explicit.
  const pendingEstimateJobs = jobs.filter((j) => {
    if (j.status !=="ESTIMATE") return false;
    const e = j.estimates[0];
    return !e || e.status ==="DRAFT";
  });
  const awaitingApprovalJobs = jobs.filter(
    (j) => j.estimates[0]?.status ==="SENT",
  );
  // Approved-not-yet-invoiced — covers the whole 'estimate approved →
  // tech doing work → ready to invoice' arc. Action button varies by
  // jobStatus (TECH_COMPLETE → 'Generate Invoice'; APPROVED/REPAIR →
  // 'Work in progress' caption). Replaces the prior standalone
  // 'Work in progress' section so the cashier doesn't see the same job
  // listed twice.
  const approvedEstimateJobs = jobs.filter(
    // Use .some() instead of [0]?.status so a stray empty DRAFT sitting
    // alongside an APPROVED estimate (legacy double-tap race) doesn't
    // hide the job from this bucket — the APPROVED row is what drives
    // "Generate Invoice", regardless of which estimate happens to be
    // chronologically newest on the job.
    (j) => j.estimates.some((e) => e.status === "APPROVED") && j.invoices.length === 0,
  );
  const rejectedEstimateJobs = jobs.filter(
    (j) => j.estimates[0]?.status ==="REJECTED",
  );
  const revisedEstimateJobs = jobs.filter(
    (j) => j.status ==="EXTRA_WORK_AWAITING_APPROVAL",
  );
  // Back-compat alias — the existing Receivables / Invoices sections
  // still reference `toReestimate`. Keep the name so the diff stays
  // focused on the Estimates tab.
  const toReestimate = revisedEstimateJobs;

  // Zero-entry ledger rollup (auto-generated rows; nothing entered by hand).
  const byAccount = new Map<string, number>();
  for (const e of ledger) {
    byAccount.set(e.account, (byAccount.get(e.account) ?? 0) + Number(e.debit) - Number(e.credit));
  }
  const revenue = -(byAccount.get(ACCOUNTS.SALES) ?? 0); // credit-normal
  const vatCollected = -(byAccount.get(ACCOUNTS.VAT_PAYABLE) ?? 0);
  const cash = byAccount.get(ACCOUNTS.CASH) ?? 0; // debit-normal
  const arOutstanding = byAccount.get(ACCOUNTS.AR) ?? 0; // debit-normal

  const now = new Date();
  // (the local 'now' above already serves the durations — passed into
  // <JobTimings> below so every per-row caption reads the same wall clock.)

  const metrics: { key: MessageKey; value: number }[] = [
    { key:"mRevenue", value: revenue },
    { key:"mVatCollected", value: vatCollected },
    { key:"mCashIn", value: cash },
    { key:"mArOutstanding", value: arOutstanding },
  ];

  // Pre-compute the Payments tab's rows from the existing invoices list
  // (same data is already fetched for Receivables; just filter to PAID
  // and sort newest-payment-first). No extra Prisma round trip.
  const paidRows = invoices
    .map((inv) => {
      const total = Number(inv.total);
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const state = arState(total, paid, inv.dueDate, now);
      const sortedPayments = [...inv.payments].sort(
        (a, b) => b.paidAt.getTime() - a.paidAt.getTime(),
      );
      const latestPayment = sortedPayments[0];
      return {
        inv,
        total,
        vat: Number(inv.vatAmount),
        state,
        paidAt: latestPayment?.paidAt ?? null,
        method: latestPayment?.method ?? null,
      };
    })
    .filter((r) => r.state ==="PAID")
    .sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0));

  // ── Dashboard counters ────────────────────────────────────────
  // Every estimate-state counter is derived from the same job-bucket
  // its section renders, so 'Approved: 14' will always equal the
  // number of rows in the 'Approved estimates' section — that's the
  // whole point of the counter→section refactor.
  //  - Pending Estimates ← pendingEstimateJobs.length
  //  - Pending Approval  ← awaitingApprovalJobs.length
  //  - Approved      ← approvedEstimateJobs.length
  //  - Rejected      ← rejectedEstimateJobs.length
  //  - Unpaid Invoices  ← invoices.length minus paidRows.length
  //             (paid/unpaid already computed for the
  //             Receivables + Payments tabs).
  //  - Paid Invoices   ← paidRows.length.
  // No new mutations, no new workflow surfaces — read-only summary.
  // Overdue = arState(...) ==="OVERDUE"for each invoice, which the
  // existing helper computes from (total, paid, dueDate, now). No new
  // round trip; just a filter over data already fetched. Recomputed
  // every render so a paid-now or a passed-due-date both flip the
  // count instantly — never a stored stale flag.
  const overdueCount = invoices.filter(
    (inv) =>
      arState(
        Number(inv.total),
        inv.payments.reduce((s, p) => s + Number(p.amount), 0),
        inv.dueDate,
        now,
      ) ==="OVERDUE",
  ).length;
  // Slice 6 — 'Partially Paid Invoices' counter. Definition is
  // date-independent: any invoice with 0 < paid < total qualifies,
  // whether it's PARTIAL (not yet overdue) or OVERDUE with some money
  // already received. That matches the invoice-status sense of
  // 'partially paid' the cashier expects ('I've taken money on this,
  // but not all of it'). Recomputed every render; no stored flag.
  const partiallyPaidCount = invoices.filter((inv) =>
    isPartiallyPaid(
      Number(inv.total),
      inv.payments.reduce((s, p) => s + Number(p.amount), 0),
    ),
  ).length;

  // Phase 5 (workflow-flip rev. 2026-06-23) — Pending Estimates /
  // Pending Approval / Rejected counters were removed. Those are now
  // advisor-owned states (see [[/advisor/estimates]] for the same
  // buckets); leaving them on the cashier header would have advertised
  // dead work the cashier can't act on. Approved + every invoice
  // counter stay — those are still cashier-actionable signals.
  const counters = {
    approvedEstimates: approvedEstimateJobs.length,
    // 'Ready for Invoice' is the tech-marked-complete bucket — jobs
    // waiting for the cashier to generate the final invoice. Same
    // value as toInvoice.length, surfaced as a counter so the
    // cashier sees the work item count at the top instead of
    // hunting through tabs.
    readyForInvoice: toInvoice.length,
    unpaidInvoices: invoices.length - paidRows.length,
    partiallyPaidInvoices: partiallyPaidCount,
    overdueInvoices: overdueCount,
    paidInvoices: paidRows.length,
  };

  const tabLabels = {
    estimates: t("cashierTabEstimates"),
    invoices: t("cashierTabInvoices"),
    payments: t("cashierTabPayments"),
    reports: t("cashierTabReports"),
  };

  const methodLabel = (m: string | null) => {
    if (m ==="CASH") return t("methodCash");
    if (m ==="CARD_POS") return t("methodCardPos");
    return m ??"—";
  };

  // ── Payments tab — server-side pagination ──────────────────────
  // Gated on `currentTab === "payments"` so other tabs never pay for
  // this. Uses raw SQL because "fully paid" is defined as
  // SUM(payment.amount) >= invoice.total, which Prisma cannot express
  // natively in a where clause. The shared fan-out (invoices query at
  // ~line 215) stays intact — it still feeds the counters that need
  // the FULL shop-wide paid/unpaid split.
  //
  // Order: MAX(paidAt) DESC — the same "latest payment first" ordering
  // paidRows uses today. Backed by Payment(paidAt) — new index below.
  //
  // Count line honesty: the FilterBar is still 100% client-side DOM
  // manipulation (see cashier-filter-bar.tsx). This count reflects
  // the SHOP-WIDE paid total. When the user types into the filter, the
  // Paginator component hides the "Showing X-Y of Z" line so we never
  // show a lying count.
  //
  // TODO(pagination): Estimates + Invoices tabs share the fan-out and
  // fan out into multiple sections per tab. Server-side pagination for
  // those is a follow-up — needs a filter-bar refactor to URL params
  // too before "filtered count" is honest across all four surfaces.
  let paymentsPageRows: typeof paidRows = [];
  let paymentsWindow: ReturnType<typeof computeWindow> | null = null;
  if (currentTab === "payments") {
    const totalRows = await prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT COUNT(*)::bigint AS n FROM (
      SELECT i.id
      FROM "Invoice" i
      LEFT JOIN "Payment" p ON p."invoiceId" = i.id
      WHERE i."garageId" = ${garageId}
      GROUP BY i.id, i.total
      HAVING COALESCE(SUM(p.amount), 0) >= i.total
    ) t`;
    const totalCount = Number(totalRows[0]?.n ?? 0);
    paymentsWindow = computeWindow({
      rawPage,
      rawPer,
      totalCount,
    });
    if (totalCount > 0) {
      const idRows = await prisma.$queryRaw<
        { id: string }[]
      >`SELECT i.id
        FROM "Invoice" i
        LEFT JOIN "Payment" p ON p."invoiceId" = i.id
        WHERE i."garageId" = ${garageId}
        GROUP BY i.id, i.total
        HAVING COALESCE(SUM(p.amount), 0) >= i.total
        ORDER BY MAX(p."paidAt") DESC NULLS LAST
        LIMIT ${paymentsWindow.take} OFFSET ${paymentsWindow.skip}`;
      const ids = idRows.map((r) => r.id);
      const rows = ids.length
        ? await prisma.invoice.findMany({
            where: { id: { in: ids }, garageId },
            include: {
              payments: true,
              jobCard: {
                include: { vehicle: { include: { customer: true } } },
              },
            },
          })
        : [];
      // Preserve the paidAt-desc order from the SQL — findMany doesn't
      // guarantee it back.
      const orderIx = new Map(ids.map((id, i) => [id, i]));
      const rowsOrdered = rows.sort(
        (a, b) => (orderIx.get(a.id) ?? 0) - (orderIx.get(b.id) ?? 0),
      );
      paymentsPageRows = rowsOrdered.map((inv) => {
        const total = Number(inv.total);
        const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        const sortedPayments = [...inv.payments].sort(
          (a, b) => b.paidAt.getTime() - a.paidAt.getTime(),
        );
        const latestPayment = sortedPayments[0];
        return {
          inv,
          total,
          vat: Number(inv.vatAmount),
          state: arState(total, paid, inv.dueDate, now),
          paidAt: latestPayment?.paidAt ?? null,
          method: latestPayment?.method ?? null,
        };
      });
    }
  }

  // Preserve every non-pagination query param so pagination links land
  // back on the same tab / filter. The Paginator itself rewrites page +
  // per; everything else is threaded through unchanged.
  const paginatorSearchParams = (() => {
    const p = new URLSearchParams();
    if (rawTab) p.set("tab", rawTab);
    if (rawFilter) p.set("filter", rawFilter);
    return p.toString();
  })();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 lg:max-w-6xl xl:max-w-7xl">
      <AppNav role="CASHIER" active="accounts"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("accounts")}</h1>

      {/* Counter badges — at-a-glance totals from data already
          fetched. Read-only; tapping a badge jumps to a filtered
          view of those records.
          Visual polish C1: each counter is now a <BadgeLink> with
          a semantic tone (success=good, warning=needs follow-up,
          info=in progress, danger=overdue/rejected). Previously each
          counter picked its own color out of a 9-color rainbow —
          now they group visually by meaning, not by author. */}
      <div className="flex flex-wrap items-center gap-2">
        <BadgeLink
          tone="success"
          href="/cashier?tab=estimates&filter=approved"
        >
          {t("counterApprovedEstimates")}{" "}
          <span className="tabular-nums font-semibold">{counters.approvedEstimates}</span>
        </BadgeLink>
        {/* Ready for Invoice — tech-marked-complete jobs awaiting the
            cashier. Info tone because it's an 'in progress / about to
            happen' workflow signal, not a follow-up.
            Each invoice counter now hands off via ?filter= so the tap
            actually drills down to the matching section, mirroring the
            estimates counters above. */}
        <BadgeLink tone="info" href="/cashier?tab=invoices&filter=ready">
          {t("counterReadyForInvoice")}{" "}
          <span className="tabular-nums font-semibold">{counters.readyForInvoice}</span>
        </BadgeLink>
        <BadgeLink tone="warning" href="/cashier?tab=invoices&filter=unpaid">
          {t("counterUnpaidInvoices")}{" "}
          <span className="tabular-nums font-semibold">{counters.unpaidInvoices}</span>
        </BadgeLink>
        <BadgeLink tone="warning" href="/cashier?tab=invoices&filter=partially_paid">
          {t("counterPartiallyPaidInvoices")}{" "}
          <span className="tabular-nums font-semibold">
            {counters.partiallyPaidInvoices}
          </span>
        </BadgeLink>
        <BadgeLink tone="danger" href="/cashier?tab=invoices&filter=overdue">
          {t("counterOverdueInvoices")}{" "}
          <span className="tabular-nums font-semibold">{counters.overdueInvoices}</span>
        </BadgeLink>
        <BadgeLink tone="success" href="/cashier?tab=payments">
          {t("counterPaidInvoices")}{" "}
          <span className="tabular-nums font-semibold">{counters.paidInvoices}</span>
        </BadgeLink>
      </div>

      {/* Tab nav — URL-driven, ?tab=… searchParam. Estimates is the
          default and renders at the canonical /cashier URL.
          The Accounts-summary metrics that used to sit above the tabs
          have moved into the Reports tab — see below. */}
      <CashierTabs currentTab={currentTab} labels={tabLabels} />

      {/* Filter bar — only shown on tabs that actually have row data.
          Customers and Reports placeholders don't need it.

          TODO(pagination): Estimates + Invoices tabs are NOT yet paginated
          — the multi-section shapes on those tabs share the fan-out
          query above and need a filter-bar rewrite (client-side DOM →
          URL params) before server-side pagination + filtered count can
          land honestly. Payments-only pagination is a first slice. */}
      {currentTab ==="estimates"||
      currentTab ==="invoices"||
      currentTab ==="payments"? (
        <CashierFilterBar
          labels={{
            searchPlaceholder: t("cashierSearchPlaceholder"),
            fromLabel: t("cashierFilterFrom"),
            toLabel: t("cashierFilterTo"),
            clearLabel: t("cashierFilterClear"),
          }}
        />
      ) : null}

      {/* ─── ESTIMATES TAB ──────────────────────────────────────── */}
      {/* Filtered-view banner — appears when ?filter= is set, naming
          the active filter and offering a one-tap return to the full
          view. Sits above the section list so the cashier sees 'this
          is a drilldown, not the whole estimates tab' at a glance. */}
      {currentTab ==="estimates"&& estimateFilter !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-info-500/40 bg-info-50 px-4 py-2.5 text-sm text-info-600 dark:border-info-500/30 dark:bg-info-500/10 dark:text-info-500">
          <span>
            {t("cashierFilterActive")}:{""}
            <span className="font-semibold">
              {/* Only 'approved' has a section to filter to on the
                  cashier side after Phase 5 (advisor owns the other
                  estimate states now). Other filter values are silently
                  treated as 'no filter' upstream — `showSection` returns
                  false for them, so this banner just shows a generic
                  label rather than naming an absent section. */}
              {t(
                estimateFilter === "approved"
                  ? "cashierApprovedEstimatesTitle"
                  : "cashierComingUpTitle",
              )}
            </span>
          </span>
          <Link
            href="/cashier?tab=estimates"
            className={BTN_GHOST_SM}
          >
            {t("cashierClearFilter")}
          </Link>
        </div>
      ) : null}

      {/* Phase 5: 'Revised estimates' section was here. The re-price
          action belongs to the advisor under the post-2026-06-23
          workflow flip — the cashier sees the same jobs in the
          read-only 'Coming up' block further down. (Block deleted —
          do not reintroduce.) */}

      {/* ─── INVOICES TAB ────────────────────────────────────────── */}
      {/* Invoice prepared but not yet sent — one-tap 'Send Invoice to
          Customer' lives right on the dashboard so the cashier doesn't
          have to dive into /invoices/[id] just to push the WhatsApp send.
          Bubbles to the very top of the action sections because it's the
          most-finished thing — only one button between here and the
          customer paying. */}
      {currentTab ==="invoices"&& showInvoiceSection("to_send") && toSendInvoice.length > 0 ? (
        <div data-filter-section>
          <h2 className="mb-2 text-sm font-medium">{t("cashierToSendInvoiceTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {toSendInvoice.map((j) => {
              const inv = j.invoices[0];
              const est = j.estimates[0];
              return (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className="flex flex-col gap-2 rounded-xl border border-warning-500/40 bg-warning-50 p-4 text-sm dark:border-warning-500/30 dark:bg-warning-500/10"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        {j.vehicle.make} {j.vehicle.model}
                      </span>
                      <span className="ms-2 text-text-mute">
                        {j.vehicle.plate} · {j.vehicle.customer.name}
                      </span>
                    </span>
                    <FriendlyStatusBadge
                      status={friendlyStatus({
                        status: j.status as JobStatus,
                        claimedById: null,
                        // We deliberately don't pass invoicePaidInFull
                        // here — the toSendInvoice bucket is, by
                        // definition, an invoice that exists but hasn't
                        // been sent yet, so payment can't have happened.
                        // AWAITING_PAYMENT is the right pill to surface
                        // the urgency ('this is the last step').
                      })}
                      t={t}
                      size="sm"
                    />
                  </div>
                  <JobTimings
                    claimedAt={j.claimedAt}
                    sentForEstimateAt={j.sentForEstimateAt}
                    estimateSentAt={est?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                  <div className="flex justify-end">
                    {inv ? (
                      <form action={sendInvoiceToCustomerAction}>
                        <input type="hidden" name="invoiceId" value={inv.id} />
                        <button
                          type="submit"
                          className={BTN_PRIMARY_MD}
                        >
                          {t("cashierSendInvoiceToCustomer")}
                        </button>
                      </form>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Stage 8 — tech marked complete, awaiting invoice send by cashier.
          Lives under the Invoices tab. */}
      {currentTab ==="invoices"&& showInvoiceSection("to_invoice") && toInvoice.length > 0 ? (
        <div data-filter-section>
          <h2 className="mb-2 text-sm font-medium">{t("cashierToInvoiceTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {toInvoice.map((j) => {
              const est = j.estimates[0];
              const existingInvoice = null; // we don't query invoices here; the estimate page is the entry point
              const hasInvoice = existingInvoice !== null; // placeholder for future expansion
              const href = est?.id ? `/estimates/${est.id}` :"/cashier";
              return (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className="flex flex-col gap-2 rounded-xl border border-info-500/40 bg-info-50 p-4 text-sm dark:border-info-500/30 dark:bg-info-500/10"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        {j.vehicle.make} {j.vehicle.model}
                      </span>
                      <span className="ms-2 text-text-mute">
                        {j.vehicle.plate} · {j.vehicle.customer.name}
                        {j.number != null ? (
                          <>
                            {""}
                            · <JobNumberBadge jobCard={j} className="tabular-nums" />
                          </>
                        ) : null}
                      </span>
                    </span>
                    <FriendlyStatusBadge
                      status="COMPLETE_AWAITING_INVOICE"
                      t={t}
                      size="sm"
                    />
                  </div>
                  <JobTimings
                    claimedAt={j.claimedAt}
                    sentForEstimateAt={j.sentForEstimateAt}
                    estimateSentAt={est?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                  <div className="flex justify-end">
                    <Link
                      href={href}
                      className={BTN_PRIMARY_MD}
                    >
                      {hasInvoice ? t("cashierGoToInvoice") : t("cashierGenerateInvoice")}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Phase 5: 'Jobs to price' section was here. Pricing belongs to
          the advisor now — these jobs surface in the 'Coming up'
          read-only block further down so the cashier still sees what's
          queued. (Block deleted — do not reintroduce.) */}

      {/* Phase 5: 'Awaiting customer approval' section was here. The
          advisor sent the estimate and owns the customer conversation —
          'View estimate' / 'Resend' both belong on the advisor side
          now. These jobs surface in 'Coming up' below. (Block deleted —
          do not reintroduce.) */}

      {/* (3) Approved estimates — covers everything from 'customer just
          said yes' to 'tech finished, ready for invoice'. Action button
          differs by jobStatus:
            APPROVED/REPAIR  → caption-only ('Work in progress'); the
                                cashier MUST NOT see Generate Invoice
                                while the tech is still working (spec §6).
            TECH_COMPLETE   → 'Generate Invoice' button — same flow as
                                the Invoices tab's Awaiting-final-invoice
                                section, surfaced here too so the cashier
                                can act from the Estimates tab.
          (This section replaces the prior standalone 'Work in progress'
          section so the same job never appears twice.) */}
      {currentTab ==="estimates"&& showSection("approved") ? (
      <div
        id="approved-estimates"
        data-filter-section
        className="scroll-mt-20 target:rounded-lg target:ring-2 target:ring-emerald-400 target:ring-offset-2"
      >
        <h2 className="mb-2 text-sm font-medium">
          {t("cashierApprovedEstimatesTitle")} ({approvedEstimateJobs.length})
        </h2>
        {approvedEstimateJobs.length === 0 ? (
          <p className="text-sm text-text-mute">
            {t("cashierApprovedEstimatesEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {approvedEstimateJobs.map((j) => {
              // Prefer the APPROVED sibling for routing — `j.estimates[0]`
              // is just the most-recent row, which can be a stale empty
              // DRAFT left over from a double-tap on "Set price". The
              // priced lines live on the APPROVED row, so 'Generate
              // Invoice' must open THAT one. Falls back to the first
              // estimate for legacy rows where no APPROVED exists.
              const est =
                j.estimates.find((e) => e.status === "APPROVED") ?? j.estimates[0];
              const techDone = j.status ==="TECH_COMPLETE";
              const fs = friendlyStatus({
                status: j.status as JobStatus,
                claimedById: j.claimedById,
                latestEstimateStatus:"APPROVED",
              });
              return (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className="flex flex-col gap-2 rounded-xl border border-success-500/40 bg-success-50 p-4 text-sm dark:border-success-500/30 dark:bg-success-500/10"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        {j.vehicle.make} {j.vehicle.model}
                      </span>
                      <span className="ms-2 text-text-mute">
                        {j.vehicle.plate} · {j.vehicle.customer.name}
                      </span>
                    </span>
                    {/* Estimate total — small caption beside the badge.
                        Lets the cashier eyeball pipeline value without
                        clicking into each row. */}
                    {est ? (
                      <span className="text-xs tabular-nums text-success-700 dark:text-success-500">
                        AED {Number(est.total).toFixed(2)}
                      </span>
                    ) : null}
                    <FriendlyStatusBadge status={fs} t={t} size="sm"/>
                  </div>
                  {techDone ? (
                    <JobTimings
                      claimedAt={j.claimedAt}
                      sentForEstimateAt={j.sentForEstimateAt}
                      estimateSentAt={est?.sentAt ?? null}
                      now={now}
                      t={t}
                    />
                  ) : (
                    <p className="text-xs text-text-mute">
                      {t("cashierWorkInProgressCaption")}
                    </p>
                  )}
                  <div className="flex justify-end">
                    {techDone && est ? (
                      <Link
                        href={`/estimates/${est.id}`}
                        className={BTN_PRIMARY_MD}
                      >
                        {t("cashierGenerateInvoice")}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      ) : null}

      {/* Phase 5: 'Rejected estimates' section was here. Rejection is
          an advisor re-price signal, not a cashier signal — removed
          entirely from the cashier dashboard (advisor sees these on
          [[/advisor/estimates]]'s Rejected section and can re-price).
          (Block deleted — do not reintroduce.) */}

      {/* (Phase 5) "Coming up" — read-only roll-up of jobs the advisor
          is currently working on. The cashier sees what's queued for
          them ('these will land on my plate once the customer approves
          + tech completes') without any actionable button, since
          pricing / sending / re-pricing all belong to the advisor.
          One unified list keyed by job id; rows are not links and
          have no buttons. We use the same status badge so the cashier
          can tell at a glance whether the advisor is still pricing,
          waiting on the customer, or pricing extra work mid-job.
          Honours the ?filter= query param the same way the Approved
          section above does — anything other than 'approved' shows
          this Coming-up list as a fallback. */}
      {currentTab === "estimates" ? (
        <div data-filter-section className="scroll-mt-20">
          <h2 className="mb-1 text-sm font-medium">
            {t("cashierComingUpTitle")} (
            {pendingEstimateJobs.length +
              awaitingApprovalJobs.length +
              revisedEstimateJobs.length}
            )
          </h2>
          <p className="mb-2 text-xs text-text-mute">
            {t("cashierComingUpHint")}
          </p>
          {pendingEstimateJobs.length +
            awaitingApprovalJobs.length +
            revisedEstimateJobs.length ===
          0 ? (
            <p className="text-sm text-text-mute">
              {t("cashierComingUpEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {[
                ...pendingEstimateJobs.map((j) => {
                  const latest = j.estimates[0];
                  return {
                    j,
                    fs: friendlyStatus({
                      status: j.status as JobStatus,
                      claimedById: null,
                      latestEstimateStatus: (latest?.status ?? null) as
                        | "DRAFT"
                        | "SENT"
                        | "APPROVED"
                        | "REJECTED"
                        | null,
                    }),
                  };
                }),
                ...awaitingApprovalJobs.map((j) => ({
                  j,
                  fs: friendlyStatus({
                    status: j.status as JobStatus,
                    claimedById: null,
                    latestEstimateStatus: "SENT" as const,
                  }),
                })),
                ...revisedEstimateJobs.map((j) => ({
                  j,
                  fs: "EXTRA_WORK_AWAITING_APPROVAL" as const,
                })),
              ].map(({ j, fs }) => (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface p-3 text-sm"
                >
                  <span className="flex flex-col">
                    <span className="font-medium">
                      {j.vehicle.make} {j.vehicle.model}
                      <span className="ms-2 text-text-mute">
                        {j.vehicle.plate}
                      </span>
                    </span>
                    <span className="text-xs text-text-mute">
                      {j.vehicle.customer.name}
                    </span>
                  </span>
                  <FriendlyStatusBadge status={fs} t={t} size="sm" />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* Tech is still diagnosing — cashier sees the job exists so they can
          anticipate workload, but no actions are available yet. Per spec,
          NO pricing buttons render on these rows.
          Lives under the Estimates tab. */}
      {/* Waiting for diagnosis hides under any filter — drill-downs
          stay clean. The counter row has no badge for this section, so
          it's only visible in the unfiltered overview anyway. */}
      {currentTab ==="estimates"&& estimateFilter === null && waitingForDiagnosis.length > 0 ? (
        <div data-filter-section>
          <h2 className="mb-2 text-sm font-medium">{t("cashierWaitingDiagnosisTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {waitingForDiagnosis.map((j) => (
              <li
                key={j.id}
                data-filter-row
                data-search={jobSearchTokens(j)}
                data-date={jobDateIso(j)}
                className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-4 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">
                      {j.vehicle.make} {j.vehicle.model}
                    </span>
                    <span className="ms-2 text-text-mute">
                      {j.vehicle.plate} · {j.vehicle.customer.name}
                    </span>
                  </span>
                  <FriendlyStatusBadge
                    status={friendlyStatus({
                      status: j.status as JobStatus,
                      claimedById: j.claimedById,
                    })}
                    t={t}
                    size="sm"
                  />
                </div>
                {/* No JobTimings here yet — diagnosis is still running and
                    we don't want to bury the 'no action needed' message
                    under live timer noise. */}
                <p className="text-xs text-text-mute">
                  {t("cashierWaitingDiagnosisCaption")}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Receivables — UNPAID invoices only. Lives under the Invoices tab.
          Once an invoice is fully paid (arState === 'PAID') it leaves this
          section and lives under the Payments tab instead. */}
      {currentTab ==="invoices"&& showInvoiceSection("receivables") ? (
      <div data-filter-section>
        <h2 className="mb-2 text-sm font-medium">{t("receivables")}</h2>
        {(() => {
          // Row-level filtering for the counter drill-downs:
          //   - 'unpaid' (or no filter)   → all non-PAID rows
          //   - 'partially_paid'           → PARTIAL only
          //   - 'overdue'                  → OVERDUE only
          // 'ready' never reaches this code path — showInvoiceSection
          // returns false for receivables when filter === 'ready'.
          const unpaid = invoices
            .map((inv) => {
              const total = Number(inv.total);
              const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
              const state = arState(total, paid, inv.dueDate, now);
              return { inv, total, paid, state };
            })
            .filter((r) => r.state !=="PAID")
            .filter((r) => {
              // 'Partially Paid' matches the counter's date-independent
              // definition — 0 < paid < total — so an invoice that is
              // both partial-paid AND past-due (state === "OVERDUE"
              // with a positive `paid`) still shows in the drill-down.
              // Previously this used `r.state === "PARTIAL"` which
              // silently hid every overdue-partial row: counter said 5,
              // list said "everything cleared." Cashier could not chase
              // the missing balance on those invoices.
              if (invoiceFilter === "partially_paid") return isPartiallyPaid(r.total, r.paid);
              if (invoiceFilter === "overdue") return r.state === "OVERDUE";
              return true;
            });
          if (unpaid.length === 0) {
            return (
              <p className="text-sm text-text-mute">
                {invoices.length === 0 ? t("noInvoices") : t("noUnpaidInvoices")}
              </p>
            );
          }
          return (
            <ul className="flex flex-col gap-1">
              {unpaid.map(({ inv, total, paid, state }) => {
                const balance = Math.max(0, total - paid);
                return (
                  <li
                    key={inv.id}
                    data-filter-row
                    data-search={invoiceSearchTokens(inv)}
                    data-date={invoiceDateIso(inv)}
                    className="flex flex-col gap-2 rounded-xl border border-border p-4 text-sm"
                  >
                    <Link
                      href={`/invoices/${inv.id}`}
                      className="flex items-center justify-between hover:underline"
                    >
                      <span>
                        <span className="font-medium">{AR_EMOJI[state]} {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}</span>
                        {/* Red Overdue pill alongside the invoice number when
                            today > dueDate AND balance > 0. The state value
                            already drives the 🔴 emoji prefix above; the
                            pill makes the at-a-glance signal explicit at
                            small sizes where the emoji can read as a
                            decoration. */}
                        {state ==="OVERDUE"? (
                          <span className="ms-2 inline-flex items-center whitespace-nowrap rounded-full bg-danger-50 text-danger-700 px-2 py-0.5 text-xs font-semibold dark:bg-danger-500/10 dark:text-danger-500">
                            {t("invoiceBadgeOverdue")}
                          </span>
                        ) : null}
                        <span className="ml-2 text-text-mute">
                          {inv.jobCard.vehicle.customer.name}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="block">{money(total)}</span>
                        <span className="block text-xs text-text-mute">
                          {`${t("dueLower")} ${fmtDate(inv.dueDate, locale, tz)}`}
                        </span>
                      </span>
                    </Link>
                    {/* Mark as Paid — inline on the Receivables row per spec.
                        This is THE place the cashier records that the
                        customer paid (Cash or Card-POS — we don't process
                        the money, we just journal it). Defaults to the
                        outstanding balance + Cash so the common case is
                        one tap; the cashier can adjust the amount for a
                        partial payment or switch the method as needed.
                        Removed from /invoices/[id] so a typo on the edit
                        page can't accidentally mark-paid before the
                        customer has actually transferred. */}
                    <form
                      action={recordPaymentAction}
                      className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2"
                    >
                      <input type="hidden" name="invoiceId" value={inv.id} />
                      <label className="flex items-center gap-1 text-xs text-text-mute">
                        {t("amount")}
                        <input
                          name="amount"
                          type="number"
                          step="0.01"
                          min="0"
                          defaultValue={balance.toFixed(2)}
                          aria-label={t("amount")}
                          className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-end text-sm tabular-nums"
                        />
                      </label>
                      <select
                        name="method"
                        defaultValue="CASH"
                        aria-label={t("colMethod")}
                        className="rounded-md border border-border bg-transparent px-2 py-1 text-xs"
                      >
                        <option value="CASH">{t("methodCash")}</option>
                        <option value="CARD_POS">{t("methodCardPos")}</option>
                      </select>
                      <button
                        type="submit"
                        className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                      >
                        {t("markAsPaid")}
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          );
        })()}
      </div>
      ) : null}

      {/* ─── PAYMENTS TAB ────────────────────────────────────────── */}
      {/* Paid invoices archive. Same data and same columns as the
          standalone /cashier/paid route — pulled into a tab here so
          the cashier has a single dashboard with everything. The
          /cashier/paid URL still resolves for any existing bookmarks. */}
      {currentTab ==="payments"? (
        <div data-filter-section>
          {paymentsWindow && paymentsWindow.totalCount === 0 ? (
            <p className="text-sm text-text-mute">
              {t("paidInvoicesEmpty")}
            </p>
          ) : (
            <>
              {/* Phone fallback: stacked card list. */}
              <ul className="flex flex-col gap-2 sm:hidden">
                {paymentsPageRows.map(({ inv, total, vat, paidAt, method }) => (
                  <li
                    key={inv.id}
                    data-filter-row
                    data-search={invoiceSearchTokens(inv)}
                    data-date={(paidAt ?? inv.issuedAt).toISOString().slice(0, 10)}
                    className="rounded-xl border border-border p-3 text-sm"
                  >
                    <Link href={`/invoices/${inv.id}`} className="block hover:underline">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium">
                          {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())} ·{""}
                          {inv.jobCard.vehicle.customer.name}
                        </span>
                        <span className="tabular-nums font-semibold">{money(total)}</span>
                      </div>
                      <div className="mt-1 text-xs text-text-mute">
                        {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model} ·{""}
                        {inv.jobCard.vehicle.plate}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-text-mute">
                        <span>{t("colVat")} {money(vat)}</span>
                        <span>
                          {t("colDatePaid")}{" "}
                          {paidAt ? fmtDate(paidAt, locale, tz) :"—"}
                        </span>
                        <span>
                          {t("colMethod")}: {methodLabel(method)}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>

              {/* Desktop: full six-column table. */}
              <div className="hidden overflow-x-auto rounded-xl border border-border sm:block">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-text-mute">
                    <tr className="text-start">
                      <th className="p-2 text-start font-medium">{t("colCustomer")}</th>
                      <th className="p-2 text-start font-medium">{t("colVehicle")}</th>
                      <th className="p-2 text-end font-medium">{t("colAmount")}</th>
                      <th className="p-2 text-end font-medium">{t("colVat")}</th>
                      <th className="p-2 text-start font-medium">{t("colDatePaid")}</th>
                      <th className="p-2 text-start font-medium">{t("colMethod")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentsPageRows.map(({ inv, total, vat, paidAt, method }) => (
                      <tr
                        key={inv.id}
                        data-filter-row
                        data-search={invoiceSearchTokens(inv)}
                        data-date={(paidAt ?? inv.issuedAt).toISOString().slice(0, 10)}
                        className="border-t border-border hover:bg-surface-2"
                      >
                        <td className="p-2">
                          <Link href={`/invoices/${inv.id}`} className="hover:underline">
                            <div className="font-medium">
                              {inv.jobCard.vehicle.customer.name}
                            </div>
                            <div className="text-xs text-text-mute">
                              {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
                            </div>
                          </Link>
                        </td>
                        <td className="p-2">
                          <div>
                            {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model}
                          </div>
                          <div className="text-xs text-text-mute">
                            {inv.jobCard.vehicle.plate}
                          </div>
                        </td>
                        <td className="p-2 text-end tabular-nums">{money(total)}</td>
                        <td className="p-2 text-end tabular-nums">{money(vat)}</td>
                        <td className="p-2 tabular-nums">
                          {paidAt ? fmtDate(paidAt, locale, tz) :"—"}
                        </td>
                        <td className="p-2">{methodLabel(method)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {paymentsWindow ? (
                <Paginator
                  currentPath="/cashier"
                  currentSearchParams={paginatorSearchParams}
                  page={paymentsWindow.page}
                  perPage={paymentsWindow.perPage}
                  pageCount={paymentsWindow.pageCount}
                  from={paymentsWindow.from}
                  to={paymentsWindow.to}
                  total={paymentsWindow.totalCount}
                  perPageOptions={PER_PAGE_OPTIONS}
                  labels={{
                    showing: t("paginationShowing"),
                    rowsPerPage: t("paginationRowsPerPage"),
                    prev: t("paginationPrev"),
                    next: t("paginationNext"),
                  }}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* Phase 5: 'Customers' tab + 'Coming soon' placeholder removed.
          The tab itself was dropped from <CashierTabs> at the same
          time; no entry point remains and ?tab=customers falls back
          to the default 'estimates' tab via VALID_TABS. */}

      {/* ─── REPORTS TAB ────────────────────────────────────────── */}
      {/* The Accounts summary metrics live here now (relocated from the
          page header). All-time aggregates — same numbers and same
          ledger-derived math as before, just rendered in a different
          place. The search/date filter bar above is intentionally NOT
          applied to these cards because they're all-time, not row-set.
          The ledgerNote caption that used to sit at the very bottom of
          the page travels with the metrics — it explains where the
          numbers come from, so it belongs next to them. */}
      {currentTab ==="reports"? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {metrics.map((m) => (
              <div
                key={m.key}
                className="rounded-xl border border-border p-3"
              >
                <div className="text-xs text-text-mute">
                  {t(m.key)}
                </div>
                <div className="text-lg font-semibold">{money(m.value)}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-text-mute">{t("ledgerNote")}</p>
        </div>
      ) : null}
    </main>
  );
}
