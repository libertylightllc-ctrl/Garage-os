import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { arState, AR_EMOJI, formatInvoiceNo, ACCOUNTS } from "@/lib/billing";
import { createEstimateAction } from "@/app/actions/billing";
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
    // Active jobs the cashier still needs to price: no estimate yet, or only a DRAFT.
    prisma.jobCard.findMany({
      where: { garageId, status: { notIn: ["DELIVERED", "CANCELLED", "INVOICED"] } },
      include: {
        vehicle: { include: { customer: true } },
        // Latest estimate drives the friendly status (SENT → 'Awaiting customer
        // approval', else 'Estimate under process').
        estimates: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, sentAt: true },
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
  //   toInvoice          — tech marked complete; awaiting final invoice.
  const waitingForDiagnosis = jobs.filter(
    (j) => j.status === "ARRIVED" || j.status === "INSPECTION",
  );
  const toInvoice = jobs.filter((j) => j.status === "TECH_COMPLETE");
  const toReestimate = jobs.filter((j) => j.status === "EXTRA_WORK_AWAITING_APPROVAL");
  const toPrice = jobs.filter((j) => {
    if (j.status !== "ESTIMATE") return false;
    const e = j.estimates[0];
    return !e || e.status === "DRAFT";
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
      <h1 className="text-2xl font-semibold tracking-tight">{t("accounts")}</h1>

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
              const draft = j.estimates[0];
              const fs = friendlyStatus({
                status: j.status as JobStatus,
                claimedById: null, // cashier doesn't care about claim — display only
                latestEstimateStatus: (draft?.status ?? null) as
                  | "DRAFT"
                  | "SENT"
                  | "APPROVED"
                  | "REJECTED"
                  | null,
              });
              return (
                <li
                  key={j.id}
                  className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
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
                  <JobTimings
                    claimedAt={j.claimedAt}
                    sentForEstimateAt={j.sentForEstimateAt}
                    estimateSentAt={draft?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                  <div className="flex justify-end">
                    {draft ? (
                      <Link
                        href={`/estimates/${draft.id}`}
                        className="rounded-md border border-black/15 px-3 py-1 font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
                      >
                        {t("continuePricing")}
                      </Link>
                    ) : (
                      <form action={createEstimateAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <button className="rounded-md bg-zinc-900 px-3 py-1 font-medium text-white dark:bg-white dark:text-black">
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

      <div>
        <h2 className="mb-2 text-sm font-medium">{t("receivables")}</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("noInvoices")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {invoices.map((inv) => {
              const total = Number(inv.total);
              const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
              const state = arState(total, paid, inv.dueDate, now);
              return (
                <li key={inv.id}>
                  <Link
                    href={`/invoices/${inv.id}`}
                    className="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
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
                        {state === "PAID" ? t("paidLower") : `${t("dueLower")} ${inv.dueDate.toISOString().slice(0, 10)}`}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs text-zinc-400">{t("ledgerNote")}</p>
    </main>
  );
}
