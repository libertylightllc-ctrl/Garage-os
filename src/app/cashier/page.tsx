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

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function CashierHome() {
  const session = await requireRole("CASHIER");
  const t = await getT();
  const garageId = session.user.garageId;

  const [invoices, ledger, jobs] = await Promise.all([
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

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="CASHIER" active="accounts" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("accounts")}</h1>
        {/* Tab to the archive of fully-paid invoices — keeps the main
            dashboard focused on active / unpaid work, while the cashier
            (or owner) can still drill into the paid pile when they need
            to reconcile or look up a past job. */}
        <Link
          href="/cashier/paid"
          className="rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {t("paidInvoicesTab")}
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.key} className="rounded-lg border border-black/10 p-3 dark:border-white/15">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(m.key)}</div>
            <div className="text-lg font-semibold">{money(m.value)}</div>
          </div>
        ))}
      </div>

      {/* Re-estimate cycle — tech found extra work mid-job. Bubbles to the
          top because the existing approved work is paused until the customer
          says yes (or no) to the extra. */}
      {toReestimate.length > 0 ? (
        <div>
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

      {/* Invoice prepared but not yet sent — one-tap 'Send Invoice to
          Customer' lives right on the dashboard so the cashier doesn't
          have to dive into /invoices/[id] just to push the WhatsApp send.
          Bubbles to the very top of the action sections because it's the
          most-finished thing — only one button between here and the
          customer paying. */}
      {toSendInvoice.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">{t("cashierToSendInvoiceTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {toSendInvoice.map((j) => {
              const inv = j.invoices[0];
              const est = j.estimates[0];
              return (
                <li
                  key={j.id}
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
          Bubbles above 'Jobs to price' because it's blocking the customer's
          payment (downstream of all the pricing work). */}
      {toInvoice.length > 0 ? (
        <div>
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
      <div>
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

      {/* Customer approved the estimate; tech is now doing the actual work.
          Per spec, the cashier MUST NOT see 'Send Invoice' or 'Prepare
          Invoice' here — the technician hasn't finished yet. Render the
          row read-only with just a caption so the cashier knows the job
          is alive and where it sits. */}
      {workInProgress.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">{t("cashierWorkInProgressTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {workInProgress.map((j) => (
              <li
                key={j.id}
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
          NO pricing buttons render on these rows. */}
      {waitingForDiagnosis.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">{t("cashierWaitingDiagnosisTitle")}</h2>
          <ul className="flex flex-col gap-1">
            {waitingForDiagnosis.map((j) => (
              <li
                key={j.id}
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

      {/* Receivables — UNPAID invoices only. Per spec, once an invoice is
          fully paid (arState === 'PAID') it leaves this section and lives
          on /cashier/paid instead, so the main dashboard stays focused on
          active work. We pre-compute the (total, paid, state) triple here
          to drive both the filter and the row render. */}
      <div>
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

      <p className="text-xs text-zinc-400">{t("ledgerNote")}</p>
    </main>
  );
}
