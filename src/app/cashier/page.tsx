import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { arState, AR_EMOJI, formatInvoiceNo, ACCOUNTS } from "@/lib/billing";
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
import { CashierTabs } from "@/components/cashier-tabs";

export const dynamic = "force-dynamic";

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
    .join(" ")
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
    .join(" ")
    .toLowerCase();
}

function invoiceDateIso(inv: InvoiceRowLike): string {
  return inv.issuedAt.toISOString().slice(0, 10);
}

// Permitted tab values; anything else falls back to 'estimates'.
const VALID_TABS = new Set<string>([
  "estimates",
  "invoices",
  "payments",
  "customers",
  "reports",
]);

export default async function CashierHome({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await requireRole("CASHIER");
  const t = await getT();
  const garageId = session.user.garageId;

  // URL-driven tabs. Default = 'estimates' so refreshing the canonical
  // /cashier URL always lands on the working tab.
  const { tab: rawTab } = await searchParams;
  const currentTab = (
    rawTab && VALID_TABS.has(rawTab) ? rawTab : "estimates"
  ) as "estimates" | "invoices" | "payments" | "customers" | "reports";

  const [invoices, ledger, jobs, estimateStatusCounts] = await Promise.all([
    prisma.invoice.findMany({
      where: { garageId },
      include: { payments: true, jobCard: { include: { vehicle: { include: { customer: true } } } } },
      orderBy: { issuedAt: "desc" },
    }),
    prisma.ledgerEntry.findMany({ where: { garageId } }),
    // Active jobs that need cashier attention at some point in the
    // lifecycle. We INCLUDE the INVOICED status now — once the invoice
    // is created the cashier still has to tap 'Send Invoice to Customer'
    // from the dashboard, so unsent invoices need to surface here. We
    // drop INVOICED+sent jobs in JS (they live in Receivables only).
    prisma.jobCard.findMany({
      where: { garageId, status: { notIn: ["DELIVERED", "CANCELLED"] } },
      include: {
        vehicle: { include: { customer: true } },
        // Latest estimate drives the friendly status (SENT → 'Awaiting customer
        // approval', else 'Estimate under process').
        estimates: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, sentAt: true },
        },
        // Latest invoice id — needed to target sendInvoiceToCustomerAction
        // from the dashboard's 'Send Invoice to Customer' button.
        invoices: {
          orderBy: { issuedAt: "desc" },
          take: 1,
          select: { id: true, number: true, total: true },
        },
      },
      orderBy: [
        // Cars freshly handed off (status=ESTIMATE) bubble to the top so
        // the cashier sees them first.
        { status: "asc" },
        { createdAt: "desc" },
      ],
    }),
    // One cheap groupBy for the dashboard counter badges (Pending
    // Approval / Approved / Rejected). Returns at most 4 rows (DRAFT,
    // SENT, APPROVED, REJECTED) — single round trip alongside the
    // existing queries.
    prisma.estimate.groupBy({
      by: ["status"],
      where: { jobCard: { garageId } },
      _count: { _all: true },
    }),
  ]);

  // Cashier dashboard buckets — each surfaces a different "what's mine to
  // do now" question, with no pricing buttons appearing until the tech
  // has actually handed the job off via Send-for-Estimate.
  //
  //   waitingForDiagnosis — tech is still working on it; cashier can SEE
  //     the job exists but has no actions yet. No buttons rendered.
  //   toPrice            — tech has sent it; cashier needs to set prices.
  //                        Either no estimate yet (just-handed-off) or a
  //                        DRAFT being assembled. Status MUST be ESTIMATE.
  //   toReestimate       — tech flagged extra work mid-job.
  //   workInProgress    — customer approved estimate; tech is doing the
  //                       work. Cashier has NO actions here — explicitly
  //                       NO 'Send Invoice' or 'Prepare Invoice' buttons
  //                       are rendered. Just a passive 'work in progress'
  //                       caption so the cashier knows what's happening.
  //   toInvoice         — tech marked complete; cashier needs to PREPARE
  //                       the invoice (edit lines + finalize). Button
  //                       takes them to the estimate review page.
  //   toSendInvoice     — invoice has been prepared (status=INVOICED) but
  //                       hasn't been sent yet (invoiceSentAt is null).
  //                       'Send Invoice to Customer' button fires
  //                       sendInvoiceToCustomerAction directly from the
  //                       dashboard so the cashier doesn't need to dive
  //                       into the invoice page.
  const waitingForDiagnosis = jobs.filter(
    (j) => j.status === "ARRIVED" || j.status === "INSPECTION",
  );
  const workInProgress = jobs.filter(
    (j) => j.status === "APPROVED" || j.status === "REPAIR",
  );
  const toInvoice = jobs.filter((j) => j.status === "TECH_COMPLETE");
  const toSendInvoice = jobs.filter(
    (j) => j.status === "INVOICED" && j.invoiceSentAt === null,
  );
  const toReestimate = jobs.filter((j) => j.status === "EXTRA_WORK_AWAITING_APPROVAL");
  // Jobs to price now accepts three estimate-state shapes:
  //   - null/missing  (fresh handoff from the tech, no estimate yet)
  //   - DRAFT         (cashier is mid-pricing)
  //   - REJECTED      (customer turned down the prior quote; setEstimate
  //                    StatusAction sends the JobCard back to ESTIMATE
  //                    status for re-pricing, but the rejected estimate
  //                    row stays attached as audit history — the cashier
  //                    needs to be able to re-price by creating a fresh
  //                    DRAFT, and previously this row was silently
  //                    excluded from every bucket. See the row render
  //                    below for the differentiated 're-price' UI.)
  const toPrice = jobs.filter((j) => {
    if (j.status !== "ESTIMATE") return false;
    const e = j.estimates[0];
    return !e || e.status === "DRAFT" || e.status === "REJECTED";
  });

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
  //  <JobTimings> below so every per-row caption reads the same wall clock.)

  const metrics: { key: MessageKey; value: number }[] = [
    { key: "mRevenue", value: revenue },
    { key: "mVatCollected", value: vatCollected },
    { key: "mCashIn", value: cash },
    { key: "mArOutstanding", value: arOutstanding },
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
    .filter((r) => r.state === "PAID")
    .sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0));

  // ── Dashboard counters ────────────────────────────────────────
  // All six values derived from data already fetched:
  //   - Pending Estimates  ← toPrice bucket length (matches the
  //                          'Jobs to price' count shown under the
  //                          Estimates tab, per spec).
  //   - Pending Approval / Approved / Rejected ← estimateStatusCounts
  //     groupBy on the same Prisma round-trip Promise.all.
  //   - Unpaid Invoices    ← invoices.length minus paidRows.length
  //                          (paid/unpaid already computed for the
  //                          Receivables + Payments tabs).
  //   - Paid Invoices      ← paidRows.length.
  // No new mutations, no new workflow surfaces — read-only summary.
  const estimateCountFor = (status: "DRAFT" | "SENT" | "APPROVED" | "REJECTED") =>
    estimateStatusCounts.find((r) => r.status === status)?._count._all ?? 0;
  const counters = {
    pendingEstimates: toPrice.length,
    pendingApproval: estimateCountFor("SENT"),
    approvedEstimates: estimateCountFor("APPROVED"),
    rejectedEstimates: estimateCountFor("REJECTED"),
    unpaidInvoices: invoices.length - paidRows.length,
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
    if (m === "CASH") return t("methodCash");
    if (m === "CARD_POS") return t("methodCardPos");
    return m ?? "—";
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="CASHIER" active="accounts" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("accounts")}</h1>

      {/* Counter badges — at-a-glance totals derived from data already
          fetched above. Read-only; tapping a badge jumps to the tab
          that lists those records. Skipped per spec: 'Partially Paid'
          (no partial-payments feature yet) and 'Today/Monthly
          Collection' (no date-based payment totals yet). */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/cashier"
          className="rounded-full border border-amber-500/40 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700/40 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          {t("counterPendingEstimates")}{" "}
          <span className="tabular-nums font-semibold">{counters.pendingEstimates}</span>
        </Link>
        <Link
          href="/cashier"
          className="rounded-full border border-orange-500/40 bg-orange-50 px-3 py-1 text-xs font-medium text-orange-900 hover:bg-orange-100 dark:border-orange-700/40 dark:bg-orange-950/40 dark:text-orange-200 dark:hover:bg-orange-900/40"
        >
          {t("counterPendingApproval")}{" "}
          <span className="tabular-nums font-semibold">{counters.pendingApproval}</span>
        </Link>
        <Link
          href="/cashier"
          className="rounded-full border border-emerald-500/40 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-900 hover:bg-emerald-100 dark:border-emerald-700/40 dark:bg-emerald-950/40 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
        >
          {t("counterApprovedEstimates")}{" "}
          <span className="tabular-nums font-semibold">{counters.approvedEstimates}</span>
        </Link>
        <Link
          href="/cashier"
          className="rounded-full border border-rose-500/40 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-900 hover:bg-rose-100 dark:border-rose-700/40 dark:bg-rose-950/40 dark:text-rose-200 dark:hover:bg-rose-900/40"
        >
          {t("counterRejectedEstimates")}{" "}
          <span className="tabular-nums font-semibold">{counters.rejectedEstimates}</span>
        </Link>
        <Link
          href="/cashier?tab=invoices"
          className="rounded-full border border-fuchsia-500/40 bg-fuchsia-50 px-3 py-1 text-xs font-medium text-fuchsia-900 hover:bg-fuchsia-100 dark:border-fuchsia-700/40 dark:bg-fuchsia-950/40 dark:text-fuchsia-200 dark:hover:bg-fuchsia-900/40"
        >
          {t("counterUnpaidInvoices")}{" "}
          <span className="tabular-nums font-semibold">{counters.unpaidInvoices}</span>
        </Link>
        <Link
          href="/cashier?tab=payments"
          className="rounded-full border border-teal-500/40 bg-teal-50 px-3 py-1 text-xs font-medium text-teal-900 hover:bg-teal-100 dark:border-teal-700/40 dark:bg-teal-950/40 dark:text-teal-200 dark:hover:bg-teal-900/40"
        >
          {t("counterPaidInvoices")}{" "}
          <span className="tabular-nums font-semibold">{counters.paidInvoices}</span>
        </Link>
      </div>

      {/* Tab nav — URL-driven, ?tab=… searchParam. Estimates is the
          default and renders at the canonical /cashier URL.
          The Accounts-summary metrics that used to sit above the tabs
          have moved into the Reports tab — see below. */}
      <CashierTabs currentTab={currentTab} labels={tabLabels} />

      {/* Filter bar — only shown on tabs that actually have row data.
          Customers and Reports placeholders don't need it. */}
      {currentTab === "estimates" ||
      currentTab === "invoices" ||
      currentTab === "payments" ? (
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
      {/* Re-estimate cycle — tech found extra work mid-job. Bubbles to the
          top because the existing approved work is paused until the customer
          says yes (or no) to the extra. */}
      {currentTab === "estimates" && toReestimate.length > 0 ? (
        <div data-filter-section>
          <h2 className="mb-2 text-sm font-medium">{t("cashierReestimateTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {toReestimate.map((j) => {
              // Latest estimate may be the originally approved one; the cashier
              // needs to add a NEW estimate for the extra work. We deep-link
              // into the existing-estimate page so they pick up the context.
              const lastEst = j.estimates[0];
              const href = lastEst?.id ? `/estimates/${lastEst.id}` : "/cashier";
              return (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className="flex flex-col gap-2 rounded-lg border border-rose-500/40 bg-rose-50 p-3 text-sm dark:border-rose-700/40 dark:bg-rose-950/30"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        {j.vehicle.make} {j.vehicle.model}
                      </span>
                      <span className="ms-2 text-zinc-500 dark:text-zinc-400">
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
                      className="rounded-md bg-rose-600 px-3 py-1 font-medium text-white hover:bg-rose-500"
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
      {currentTab === "invoices" && toSendInvoice.length > 0 ? (
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
                  className="flex flex-col gap-2 rounded-lg border border-fuchsia-500/40 bg-fuchsia-50 p-3 text-sm dark:border-fuchsia-700/40 dark:bg-fuchsia-950/30"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        {j.vehicle.make} {j.vehicle.model}
                      </span>
                      <span className="ms-2 text-zinc-500 dark:text-zinc-400">
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
                          className="rounded-md bg-fuchsia-600 px-3 py-1 font-medium text-white hover:bg-fuchsia-500"
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
      {currentTab === "invoices" && toInvoice.length > 0 ? (
        <div data-filter-section>
          <h2 className="mb-2 text-sm font-medium">{t("cashierToInvoiceTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {toInvoice.map((j) => {
              const est = j.estimates[0];
              const existingInvoice = null; // we don't query invoices here; the estimate page is the entry point
              const hasInvoice = existingInvoice !== null; // placeholder for future expansion
              const href = est?.id ? `/estimates/${est.id}` : "/cashier";
              return (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className="flex flex-col gap-2 rounded-lg border border-teal-500/40 bg-teal-50 p-3 text-sm dark:border-teal-700/40 dark:bg-teal-950/30"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        {j.vehicle.make} {j.vehicle.model}
                      </span>
                      <span className="ms-2 text-zinc-500 dark:text-zinc-400">
                        {j.vehicle.plate} · {j.vehicle.customer.name}
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
                      className="rounded-md bg-teal-600 px-3 py-1 font-medium text-white hover:bg-teal-500"
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

      {/* Jobs to price — the technician → cashier handoff. The cashier sets the price. */}
      {currentTab === "estimates" ? (
      <div data-filter-section>
        <h2 className="mb-2 text-sm font-medium">{t("jobsToPrice")}</h2>
        {toPrice.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("noJobsToPrice")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {toPrice.map((j) => {
              // 'latest' replaces the old 'draft' name because under the
              // widened filter it may be a REJECTED estimate (not just a
              // DRAFT). Three render branches result from its status:
              //   DRAFT     → 'Continue pricing' Link to the DRAFT row
              //               (cashier keeps editing what they started).
              //   REJECTED  → 'Re-price' button that fires
              //               createEstimateAction → creates a FRESH
              //               DRAFT estimate. The REJECTED row stays
              //               untouched (audit trail preserved). On the
              //               next dashboard render, estimates[0] will
              //               be the new DRAFT and the row reverts to
              //               the DRAFT branch above.
              //   null      → 'Set price' button, same flow as REJECTED
              //               but without the rejection caption.
              const latest = j.estimates[0];
              const wasRejected = latest?.status === "REJECTED";
              const fs = friendlyStatus({
                status: j.status as JobStatus,
                claimedById: null, // cashier doesn't care about claim — display only
                latestEstimateStatus: (latest?.status ?? null) as
                  | "DRAFT"
                  | "SENT"
                  | "APPROVED"
                  | "REJECTED"
                  | null,
              });
              return (
                <li
                  key={j.id}
                  data-filter-row
                  data-search={jobSearchTokens(j)}
                  data-date={jobDateIso(j)}
                  className={
                    "flex flex-col gap-2 rounded-lg border p-3 text-sm " +
                    (wasRejected
                      ? "border-rose-500/40 bg-rose-50 dark:border-rose-700/40 dark:bg-rose-950/30"
                      : "border-black/10 dark:border-white/15")
                  }
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        {j.vehicle.make} {j.vehicle.model}
                      </span>
                      <span className="ms-2 text-zinc-500 dark:text-zinc-400">
                        {j.vehicle.plate} · {j.vehicle.customer.name}
                      </span>
                    </span>
                    <FriendlyStatusBadge status={fs} t={t} size="sm" />
                  </div>
                  {wasRejected ? (
                    <p className="text-xs font-medium text-rose-700 dark:text-rose-400">
                      ⚠️ {t("estimateRejectedRePriceNeeded")}
                    </p>
                  ) : null}
                  <JobTimings
                    claimedAt={j.claimedAt}
                    sentForEstimateAt={j.sentForEstimateAt}
                    estimateSentAt={latest?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                  <div className="flex justify-end">
                    {latest && latest.status === "DRAFT" ? (
                      <Link
                        href={`/estimates/${latest.id}`}
                        className="rounded-md border border-black/15 px-3 py-1 font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
                      >
                        {t("continuePricing")}
                      </Link>
                    ) : (
                      // null OR REJECTED — both create a fresh DRAFT.
                      // createEstimateAction does prisma.estimate.create
                      // so the prior REJECTED row is NEVER touched (no
                      // delete, no update) — full audit history is
                      // preserved.
                      <form action={createEstimateAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <button
                          className={
                            "rounded-md px-3 py-1 font-medium text-white " +
                            (wasRejected
                              ? "bg-rose-600 hover:bg-rose-500"
                              : "bg-zinc-900 dark:bg-white dark:text-black")
                          }
                        >
                          {wasRejected ? t("rePrice") : t("setPrice")}
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

      {/* Customer approved the estimate; tech is now doing the actual work.
          Per spec, the cashier MUST NOT see 'Send Invoice' or 'Prepare
          Invoice' here — the technician hasn't finished yet. Render the
          row read-only with just a caption so the cashier knows the job
          is alive and where it sits.
          Lives under the Estimates tab. */}
      {currentTab === "estimates" && workInProgress.length > 0 ? (
        <div data-filter-section>
          <h2 className="mb-2 text-sm font-medium">{t("cashierWorkInProgressTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {workInProgress.map((j) => (
              <li
                key={j.id}
                data-filter-row
                data-search={jobSearchTokens(j)}
                data-date={jobDateIso(j)}
                className="flex flex-col gap-2 rounded-lg border border-emerald-500/40 bg-emerald-50 p-3 text-sm dark:border-emerald-700/40 dark:bg-emerald-950/30"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">
                      {j.vehicle.make} {j.vehicle.model}
                    </span>
                    <span className="ms-2 text-zinc-500 dark:text-zinc-400">
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
                {/* No JobTimings here either — the action surface that
                    matters for the cashier (Prepare Invoice) doesn't open
                    until the tech taps Finish, so live durations would
                    only add noise. */}
                <p className="text-xs text-zinc-600 dark:text-zinc-300">
                  {t("cashierWorkInProgressCaption")}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Tech is still diagnosing — cashier sees the job exists so they can
          anticipate workload, but no actions are available yet. Per spec,
          NO pricing buttons render on these rows.
          Lives under the Estimates tab. */}
      {currentTab === "estimates" && waitingForDiagnosis.length > 0 ? (
        <div data-filter-section>
          <h2 className="mb-2 text-sm font-medium">{t("cashierWaitingDiagnosisTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {waitingForDiagnosis.map((j) => (
              <li
                key={j.id}
                data-filter-row
                data-search={jobSearchTokens(j)}
                data-date={jobDateIso(j)}
                className="flex flex-col gap-2 rounded-lg border border-black/10 bg-zinc-50 p-3 text-sm dark:border-white/15 dark:bg-zinc-900/40"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">
                      {j.vehicle.make} {j.vehicle.model}
                    </span>
                    <span className="ms-2 text-zinc-500 dark:text-zinc-400">
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
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
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
      {currentTab === "invoices" ? (
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
            .filter((r) => r.state !== "PAID");
          if (unpaid.length === 0) {
            return (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
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
                    className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
                  >
                    <Link
                      href={`/invoices/${inv.id}`}
                      className="flex items-center justify-between hover:underline"
                    >
                      <span>
                        <span className="font-medium">{AR_EMOJI[state]} {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}</span>
                        <span className="ml-2 text-zinc-500 dark:text-zinc-400">
                          {inv.jobCard.vehicle.customer.name}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="block">{money(total)}</span>
                        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
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
                      className="flex flex-wrap items-center justify-end gap-2 border-t border-black/5 pt-2 dark:border-white/10"
                    >
                      <input type="hidden" name="invoiceId" value={inv.id} />
                      <label className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {t("amount")}
                        <input
                          name="amount"
                          type="number"
                          step="0.01"
                          min="0"
                          defaultValue={balance.toFixed(2)}
                          aria-label={t("amount")}
                          className="w-24 rounded-md border border-black/15 bg-transparent px-2 py-1 text-end text-sm tabular-nums dark:border-white/20"
                        />
                      </label>
                      <select
                        name="method"
                        defaultValue="CASH"
                        aria-label={t("colMethod")}
                        className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-xs dark:border-white/20"
                      >
                        <option value="CASH">{t("methodCash")}</option>
                        <option value="CARD_POS">{t("methodCardPos")}</option>
                      </select>
                      <button
                        type="submit"
                        className="rounded-md bg-green-600 px-3 py-1 text-sm font-semibold text-white hover:bg-green-500"
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
      {currentTab === "payments" ? (
        <div data-filter-section>
          {paidRows.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
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
                    className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
                  >
                    <Link href={`/invoices/${inv.id}`} className="block hover:underline">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium">
                          {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())} ·{" "}
                          {inv.jobCard.vehicle.customer.name}
                        </span>
                        <span className="tabular-nums font-semibold">{money(total)}</span>
                      </div>
                      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model} ·{" "}
                        {inv.jobCard.vehicle.plate}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-600 dark:text-zinc-300">
                        <span>{t("colVat")} {money(vat)}</span>
                        <span>
                          {t("colDatePaid")}{" "}
                          {paidAt ? paidAt.toISOString().slice(0, 10) : "—"}
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
              <div className="hidden overflow-x-auto rounded-lg border border-black/10 sm:block dark:border-white/15">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-zinc-600 dark:bg-zinc-900/40 dark:text-zinc-300">
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
                        className="border-t border-black/10 hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
                      >
                        <td className="p-2">
                          <Link href={`/invoices/${inv.id}`} className="hover:underline">
                            <div className="font-medium">
                              {inv.jobCard.vehicle.customer.name}
                            </div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400">
                              {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
                            </div>
                          </Link>
                        </td>
                        <td className="p-2">
                          <div>
                            {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model}
                          </div>
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                            {inv.jobCard.vehicle.plate}
                          </div>
                        </td>
                        <td className="p-2 text-end tabular-nums">{money(total)}</td>
                        <td className="p-2 text-end tabular-nums">{money(vat)}</td>
                        <td className="p-2 tabular-nums">
                          {paidAt ? paidAt.toISOString().slice(0, 10) : "—"}
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
      {currentTab === "customers" ? (
        <div className="rounded-lg border border-dashed border-black/15 p-10 text-center dark:border-white/20">
          <h2 className="text-lg font-semibold tracking-tight">
            {t("cashierTabCustomersHeading")}
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
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
      {currentTab === "reports" ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {metrics.map((m) => (
              <div
                key={m.key}
                className="rounded-lg border border-black/10 p-3 dark:border-white/15"
              >
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t(m.key)}
                </div>
                <div className="text-lg font-semibold">{money(m.value)}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-400">{t("ledgerNote")}</p>
        </div>
      ) : null}
    </main>
  );
}
