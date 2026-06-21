import Link from "next/link";
import { requireRole } from "@/lib/guard";
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
  createEstimateAction,
  sendInvoiceToCustomerAction,
  recordPaymentAction,
} from "@/app/actions/billing";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { friendlyStatus, type JobStatus } from "@/lib/jobcard-status";
import { FriendlyStatusBadge } from "@/components/friendly-status-badge";
import { JobTimings } from "@/components/job-timings";
import { CashierFilterBar } from "@/components/cashier-filter-bar";
import { BadgeLink } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { CashierTabs } from "@/components/cashier-tabs";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

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
"customers",
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

export default async function CashierHome({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; filter?: string }>;
}) {
  const session = await requireRole("CASHIER");
  const t = await getT();
  const garageId = session.user.garageId;

  // URL-driven tabs. Default = 'estimates' so refreshing the canonical
  // /cashier URL always lands on the working tab.
  const { tab: rawTab, filter: rawFilter } = await searchParams;
  const currentTab = (
    rawTab && VALID_TABS.has(rawTab) ? rawTab :"estimates"
  ) as"estimates"|"invoices"|"payments"|"customers"|"reports";
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

  const [invoices, ledger, jobs] = await Promise.all([
    prisma.invoice.findMany({
      where: { garageId },
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

  const counters = {
    pendingEstimates: pendingEstimateJobs.length,
    pendingApproval: awaitingApprovalJobs.length,
    approvedEstimates: approvedEstimateJobs.length,
    rejectedEstimates: rejectedEstimateJobs.length,
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
    customers: t("cashierTabCustomers"),
    reports: t("cashierTabReports"),
  };

  const methodLabel = (m: string | null) => {
    if (m ==="CASH") return t("methodCash");
    if (m ==="CARD_POS") return t("methodCardPos");
    return m ??"—";
  };

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
          tone="warning"
          href="/cashier?tab=estimates&filter=pending_estimates"
        >
          {t("counterPendingEstimates")}{""}
          <span className="tabular-nums font-semibold">{counters.pendingEstimates}</span>
        </BadgeLink>
        <BadgeLink
          tone="warning"
          href="/cashier?tab=estimates&filter=pending_approval"
        >
          {t("counterPendingApproval")}{""}
          <span className="tabular-nums font-semibold">{counters.pendingApproval}</span>
        </BadgeLink>
        <BadgeLink
          tone="success"
          href="/cashier?tab=estimates&filter=approved"
        >
          {t("counterApprovedEstimates")}{""}
          <span className="tabular-nums font-semibold">{counters.approvedEstimates}</span>
        </BadgeLink>
        <BadgeLink
          tone="danger"
          href="/cashier?tab=estimates&filter=rejected"
        >
          {t("counterRejectedEstimates")}{""}
          <span className="tabular-nums font-semibold">{counters.rejectedEstimates}</span>
        </BadgeLink>
        {/* Ready for Invoice — tech-marked-complete jobs awaiting the
            cashier. Info tone because it's an 'in progress / about to
            happen' workflow signal, not a follow-up. */}
        <BadgeLink tone="info" href="/cashier?tab=invoices">
          {t("counterReadyForInvoice")}{""}
          <span className="tabular-nums font-semibold">{counters.readyForInvoice}</span>
        </BadgeLink>
        <BadgeLink tone="warning" href="/cashier?tab=invoices">
          {t("counterUnpaidInvoices")}{""}
          <span className="tabular-nums font-semibold">{counters.unpaidInvoices}</span>
        </BadgeLink>
        <BadgeLink tone="warning" href="/cashier?tab=invoices">
          {t("counterPartiallyPaidInvoices")}{""}
          <span className="tabular-nums font-semibold">
            {counters.partiallyPaidInvoices}
          </span>
        </BadgeLink>
        <BadgeLink tone="danger" href="/cashier?tab=invoices">
          {t("counterOverdueInvoices")}{""}
          <span className="tabular-nums font-semibold">{counters.overdueInvoices}</span>
        </BadgeLink>
        <BadgeLink tone="success" href="/cashier?tab=payments">
          {t("counterPaidInvoices")}{""}
          <span className="tabular-nums font-semibold">{counters.paidInvoices}</span>
        </BadgeLink>
      </div>

      {/* Tab nav — URL-driven, ?tab=… searchParam. Estimates is the
          default and renders at the canonical /cashier URL.
          The Accounts-summary metrics that used to sit above the tabs
          have moved into the Reports tab — see below. */}
      <CashierTabs currentTab={currentTab} labels={tabLabels} />

      {/* Filter bar — only shown on tabs that actually have row data.
          Customers and Reports placeholders don't need it. */}
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
              {t(
                (
                  {
                    pending_estimates:"jobsToPrice",
                    pending_approval:"cashierAwaitingApprovalTitle",
                    approved:"cashierApprovedEstimatesTitle",
                    rejected:"cashierRejectedEstimatesTitle",
                    revised:"cashierRevisedEstimatesTitle",
                  } as const
                )[estimateFilter],
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

      {/* Revised estimates — tech found extra work mid-job. Bubbles to the
          top because the existing approved work is paused until the customer
          says yes (or no) to the extra. */}
      {currentTab ==="estimates"&& showSection("revised") && revisedEstimateJobs.length > 0 ? (
        <div
          id="revised-estimates"
          data-filter-section
          className="scroll-mt-20 target:rounded-lg target:ring-2 target:ring-rose-400 target:ring-offset-2"
        >
          <h2 className="mb-2 text-sm font-medium">
            {t("cashierRevisedEstimatesTitle")} ({revisedEstimateJobs.length})
          </h2>
          <ul className="flex flex-col gap-1">
            {revisedEstimateJobs.map((j) => {
              // Latest estimate may be the originally approved one; the cashier
              // needs to add a NEW estimate for the extra work. We deep-link
              // into the existing-estimate page so they pick up the context.
              const lastEst = j.estimates[0];
              const href = lastEst?.id ? `/estimates/${lastEst.id}` :"/cashier";
              return (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className="flex flex-col gap-2 rounded-xl border border-danger-500/40 bg-danger-50 p-4 text-sm dark:border-danger-500/30 dark:bg-danger-500/10"
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
                      status="EXTRA_WORK_AWAITING_APPROVAL"
                      t={t}
                      size="sm"
                    />
                  </div>
                  <JobTimings
                    claimedAt={j.claimedAt}
                    sentForEstimateAt={j.sentForEstimateAt}
                    estimateSentAt={lastEst?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                  <div className="flex justify-end">
                    <Link
                      href={href}
                      className={BTN_PRIMARY_MD}
                    >
                      {t("cashierPriceExtraWork")}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* ─── INVOICES TAB ────────────────────────────────────────── */}
      {/* Invoice prepared but not yet sent — one-tap 'Send Invoice to
          Customer' lives right on the dashboard so the cashier doesn't
          have to dive into /invoices/[id] just to push the WhatsApp send.
          Bubbles to the very top of the action sections because it's the
          most-finished thing — only one button between here and the
          customer paying. */}
      {currentTab ==="invoices"&& toSendInvoice.length > 0 ? (
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
      {currentTab ==="invoices"&& toInvoice.length > 0 ? (
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
                            · <span className="tabular-nums">#{j.number}</span>
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

      {/* (1) Jobs to price — fresh handoff from tech, OR a DRAFT the
          cashier is still assembling. REJECTED rows are NOT here — they
          moved to their own 'Rejected estimates' section below so the
          Rejected counter has a 1:1 landing place. */}
      {currentTab ==="estimates"&& showSection("pending_estimates") ? (
      <div
        id="pending-estimates"
        data-filter-section
        className="scroll-mt-20 target:rounded-lg target:ring-2 target:ring-amber-400 target:ring-offset-2"
      >
        <h2 className="mb-2 text-sm font-medium">
          {t("jobsToPrice")} ({pendingEstimateJobs.length})
        </h2>
        {pendingEstimateJobs.length === 0 ? (
          <p className="text-sm text-text-mute">{t("noJobsToPrice")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {pendingEstimateJobs.map((j) => {
              // DRAFT → 'Continue pricing' (deep-link to the in-progress
              // estimate). null (no estimate yet) → 'Set price' button
              // which fires createEstimateAction.
              const latest = j.estimates[0];
              const fs = friendlyStatus({
                status: j.status as JobStatus,
                claimedById: null,
                latestEstimateStatus: (latest?.status ?? null) as
                  |"DRAFT"
                  |"SENT"
                  |"APPROVED"
                  |"REJECTED"
                  | null,
              });
              return (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className="flex flex-col gap-2 rounded-xl border border-border p-4 text-sm"
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
                    <FriendlyStatusBadge status={fs} t={t} size="sm"/>
                  </div>
                  <JobTimings
                    claimedAt={j.claimedAt}
                    sentForEstimateAt={j.sentForEstimateAt}
                    estimateSentAt={latest?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                  <div className="flex justify-end">
                    {latest && latest.status ==="DRAFT"? (
                      <ButtonLink
                        href={`/estimates/${latest.id}`}
                        size="sm"
                      >
                        {t("continuePricing")}
                      </ButtonLink>
                    ) : (
                      <form action={createEstimateAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <button className={BTN_PRIMARY_MD}>
                          {t("setPrice")}
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      ) : null}

      {/* (2) Awaiting customer approval — estimate has been SENT to the
          customer via WhatsApp; waiting for a reply. Cashier actions are
          'View estimate' (jump into the editor) and 'Resend' (which links
          to the preview where the existing send action lives — preserves
          the cashier-reviews-before-send guard from earlier slices). */}
      {currentTab ==="estimates"&& showSection("pending_approval") ? (
      <div
        id="awaiting-approval"
        data-filter-section
        className="scroll-mt-20 target:rounded-lg target:ring-2 target:ring-orange-400 target:ring-offset-2"
      >
        <h2 className="mb-2 text-sm font-medium">
          {t("cashierAwaitingApprovalTitle")} ({awaitingApprovalJobs.length})
        </h2>
        {awaitingApprovalJobs.length === 0 ? (
          <p className="text-sm text-text-mute">
            {t("cashierAwaitingApprovalEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {awaitingApprovalJobs.map((j) => {
              const est = j.estimates[0];
              const fs = friendlyStatus({
                status: j.status as JobStatus,
                claimedById: null,
                latestEstimateStatus:"SENT",
              });
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
                    <FriendlyStatusBadge status={fs} t={t} size="sm"/>
                  </div>
                  <JobTimings
                    claimedAt={j.claimedAt}
                    sentForEstimateAt={j.sentForEstimateAt}
                    estimateSentAt={est?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    {est ? (
                      <>
                        <ButtonLink href={`/estimates/${est.id}`} size="sm">
                          {t("cashierViewEstimate")}
                        </ButtonLink>
                        {/* Resend goes via the preview gate (same as the
                            estimate's own page) — the cashier reviews the
                            customer-facing layout before the WhatsApp
                            send fires, matching the slice-2 review-gate
                            contract. */}
                        <Link
                          href={`/estimates/${est.id}/preview`}
                          className={BTN_PRIMARY_MD}
                        >
                          {t("cashierResendEstimate")}
                        </Link>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      ) : null}

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

      {/* (4) Rejected estimates — customer turned it down. 'Revise
          estimate' fires createEstimateAction → creates a fresh DRAFT;
          the REJECTED row stays untouched as audit history. */}
      {currentTab ==="estimates"&& showSection("rejected") ? (
      <div
        id="rejected-estimates"
        data-filter-section
        className="scroll-mt-20 target:rounded-lg target:ring-2 target:ring-rose-400 target:ring-offset-2"
      >
        <h2 className="mb-2 text-sm font-medium">
          {t("cashierRejectedEstimatesTitle")} ({rejectedEstimateJobs.length})
        </h2>
        {rejectedEstimateJobs.length === 0 ? (
          <p className="text-sm text-text-mute">
            {t("cashierRejectedEstimatesEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rejectedEstimateJobs.map((j) => {
              const est = j.estimates[0];
              const fs = friendlyStatus({
                status: j.status as JobStatus,
                claimedById: null,
                latestEstimateStatus:"REJECTED",
              });
              return (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className="flex flex-col gap-2 rounded-xl border border-danger-500/40 bg-danger-50 p-4 text-sm dark:border-danger-500/30 dark:bg-danger-500/10"
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
                    {est ? (
                      <span className="text-xs tabular-nums text-danger-700 dark:text-danger-500">
                        AED {Number(est.total).toFixed(2)}
                      </span>
                    ) : null}
                    <FriendlyStatusBadge status={fs} t={t} size="sm"/>
                  </div>
                  <p className="text-xs font-medium text-danger-700 dark:text-danger-500">
                    ⚠️ {t("estimateRejectedRePriceNeeded")}
                  </p>
                  <div className="flex flex-wrap justify-end gap-2">
                    {est ? (
                      <ButtonLink href={`/estimates/${est.id}`} size="sm">
                        {t("cashierViewEstimate")}
                      </ButtonLink>
                    ) : null}
                    <form action={createEstimateAction}>
                      <input type="hidden" name="jobId" value={j.id} />
                      <button className={BTN_PRIMARY_MD}>
                        {t("cashierReviseEstimate")}
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
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
      {currentTab ==="invoices"? (
      <div data-filter-section>
        <h2 className="mb-2 text-sm font-medium">{t("receivables")}</h2>
        {(() => {
          const unpaid = invoices
            .map((inv) => {
              const total = Number(inv.total);
              const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
              const state = arState(total, paid, inv.dueDate, now);
              return { inv, total, paid, state };
            })
            .filter((r) => r.state !=="PAID");
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
                          {`${t("dueLower")} ${inv.dueDate.toISOString().slice(0, 10)}`}
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
          {paidRows.length === 0 ? (
            <p className="text-sm text-text-mute">
              {t("paidInvoicesEmpty")}
            </p>
          ) : (
            <>
              {/* Phone fallback: stacked card list. */}
              <ul className="flex flex-col gap-2 sm:hidden">
                {paidRows.map(({ inv, total, vat, paidAt, method }) => (
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
                          {t("colDatePaid")}{""}
                          {paidAt ? paidAt.toISOString().slice(0, 10) :"—"}
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
                    {paidRows.map(({ inv, total, vat, paidAt, method }) => (
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
                          {paidAt ? paidAt.toISOString().slice(0, 10) :"—"}
                        </td>
                        <td className="p-2">{methodLabel(method)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ─── CUSTOMERS TAB ──────────────────────────────────────── */}
      {currentTab ==="customers"? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <h2 className="text-lg font-semibold tracking-tight">
            {t("cashierTabCustomersHeading")}
          </h2>
          <p className="mt-1 text-sm text-text-mute">
            {t("cashierTabComingSoon")}
          </p>
        </div>
      ) : null}

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
