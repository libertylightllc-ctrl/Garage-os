import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { type StaffRole } from "@/lib/roles";
import { getLocale, getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { DictateInput } from "@/components/dictate";
import {
  addEstimateLineAction,
  addLineFromPartAction,
  setEstimateStatusAction,
  generateInvoiceAction,
  recordAdvancePaymentAction,
} from "@/app/actions/billing";
import { balanceDue } from "@/lib/billing";
import { translateLineDescription } from "@/lib/line-item-translations";
import { EstimateLineRow } from "@/components/estimate-line-row";
import { EstimateLineCard } from "@/components/estimate-line-card";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

// A technician part row with a one-click"Price this part"button (when editable).
function PartRow({
  p,
  estimateId,
  editable,
  t,
}: {
  p: { id: string; partNo: string | null; description: string; qty: number };
  estimateId: string;
  editable: boolean;
  t: (k: MessageKey) => string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-base text-zinc-600 dark:text-text-mute">
      <span>
        • {p.partNo ? `${p.partNo} ` :""}
        {p.description} ×{p.qty}
      </span>
      {editable ? (
        <form action={addLineFromPartAction}>
          <input type="hidden" name="estimateId" value={estimateId} />
          <input type="hidden" name="jobPartId" value={p.id} />
          <button className="shrink-0 rounded-md border border-black/15 px-3 py-2 text-sm font-medium hover:bg-surface-2 dark:border-white/20">
            {t("priceThisPart")}
          </button>
        </form>
      ) : null}
    </li>
  );
}

// Shared screen: the Cashier sets prices here; the Advisor can view + send it.
export default async function EstimateEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAnyRole(["ADVISOR","CASHIER","OWNER"]);
  const role = session.user.role as StaffRole;
  const canPrice = role ==="CASHIER"|| role ==="OWNER"; // edit lines / invoice

  const est = await prisma.estimate.findFirst({
    where: { id, jobCard: { garageId: session.user.garageId } },
    include: {
      lines: { orderBy: { createdAt:"asc"} },
      jobCard: {
        // jobCard.status is what gates 'Generate Invoice' per spec —
        // the cashier must NOT be able to invoice while the technician
        // is still doing the work. Only TECH_COMPLETE (or beyond,
        // when an invoice already exists) unlocks the action.
        include: {
          vehicle: true,
          finding: true,
          jobParts: { orderBy: { createdAt:"asc"} },
          // Slice 6b — show advances received against this job in the
          // UI block below. Ordered oldest-first so the audit list reads
          // naturally top-to-bottom.
          advancePayments: { orderBy: { receivedAt:"asc"} },
          // Also pull sibling approved estimates so the SUM-based
          // approved-total ceiling matches what the server action uses
          // for its overpayment block. Same query, no round trip.
          estimates: {
            where: { status:"APPROVED"},
            select: { id: true, total: true },
          },
        },
      },
      invoice: { select: { id: true } },
    },
  });
  if (!est) notFound();
  // Pull the job-card status out for readability — it drives the
  // Generate-Invoice gate below.
  const jobStatus = est.jobCard.status;
  const workNotComplete = jobStatus ==="APPROVED"|| jobStatus ==="REPAIR";
  const t = await getT();
  const locale = await getLocale();
  const dictLabels = {
    start: t("dictateStart"),
    stop: t("dictateStop"),
    listening: t("dictateListening"),
    error: t("dictateError"),
  };
  const finding = est.jobCard.finding;
  const requiredParts = est.jobCard.jobParts.filter((p) => p.kind ==="REQUIRED");
  const usedParts = est.jobCard.jobParts.filter((p) => p.kind ==="USED");
  const workNotes = est.jobCard.workNotes;

  const editable = canPrice && est.status ==="DRAFT";
  const canDecline = canPrice && !est.invoice; // skip lines until the invoice is cut
  const backHref = role ==="ADVISOR"? `/advisor/jobs/${est.jobCardId}` :"/cashier";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role={role} active={role ==="ADVISOR"?"jobs":"accounts"} />
      <div>
        <Link href={backHref} className="inline-block py-2 text-base text-zinc-500 hover:underline dark:text-zinc-400">
          {role ==="ADVISOR"? t("backJob") : t("accounts")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("estimate")}</h1>
        <p className="text-base text-zinc-600 dark:text-text-mute">
          {est.jobCard.vehicle.make} {est.jobCard.vehicle.model} · {est.jobCard.vehicle.plate} ·{""}
          <span className="font-medium">{est.status}</span>
        </p>
        {!canPrice ? (
          <p className="text-sm text-zinc-400">{t("pricingByCashier")}</p>
        ) : null}
        {est.approvedAt ? (
          <p className="text-sm text-green-700 dark:text-green-400">
            ✅ {t("approvedOn")} AED {Number(est.approvedAmount ?? est.total).toFixed(2)} ·{""}
            {est.approvedAt.toISOString().slice(0, 10)}
          </p>
        ) : null}
      </div>

      {/* Technician findings & parts required — what the cashier prices from */}
      {finding?.submittedAt || requiredParts.length > 0 ? (
        <div className="rounded-lg border border-black/10 p-4 text-base dark:border-white/15">
          <h2 className="mb-2 text-base font-semibold">{t("techFindingsPanel")}</h2>
          {finding?.findings ? <p>{finding.findings}</p> : null}
          {finding?.diagnosis ? (
            <p className="text-zinc-600 dark:text-text-mute">{finding.diagnosis}</p>
          ) : null}
          {requiredParts.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {requiredParts.map((p) => (
                <PartRow key={p.id} p={p} estimateId={est.id} editable={editable} t={t} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Parts used & work notes (Repair stage) — reconcile Final Billing */}
      {usedParts.length > 0 || workNotes ? (
        <div className="rounded-lg border border-black/10 p-4 text-base dark:border-white/15">
          <h2 className="mb-2 text-base font-semibold">{t("partsUsedPanel")}</h2>
          {workNotes ? <p className="text-zinc-600 dark:text-text-mute">{workNotes}</p> : null}
          {usedParts.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {usedParts.map((p) => (
                <PartRow key={p.id} p={p} estimateId={est.id} editable={editable} t={t} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Lines — responsive layout:
          - Mobile (< md / 768px): stacked cards. Action buttons fit on
            the same row as the Type badge, so Edit / Skip / Delete are
            never cut off. Vehicle make/model/year appear as a small
            one-liner under the badge.
          - Desktop (md+): the wide 9-column table, scoped to a single
            overflow-x-auto container in case a narrow laptop window
            still needs a sideways nudge.
          Both render the same data + actions — only the layout differs,
          so totals/VAT/qty/price flow identically. */}
      {est.lines.length > 0 ? (
        <>
          {/* Mobile card list */}
          <div className="flex flex-col gap-3 md:hidden">
            {est.lines.map((l) => (
              <EstimateLineCard
                key={l.id}
                estimateId={est.id}
                editable={editable}
                canDecline={canDecline}
                vehicle={{
                  make: est.jobCard.vehicle.make,
                  model: est.jobCard.vehicle.model,
                  year: est.jobCard.vehicle.year,
                }}
                line={{
                  id: l.id,
                  kind: l.kind,
                  description: l.description,
                  qty: Number(l.qty),
                  unitPrice: Number(l.unitPrice),
                  lineTotal: Number(l.lineTotal),
                  declined: l.declined,
                }}
                displayDescription={translateLineDescription(l.description, locale)}
                labels={{
                  edit: t("editLine"),
                  delete: t("deleteLine"),
                  save: t("saveLine"),
                  cancel: t("cancelLine"),
                  skip: t("skip"),
                  restore: t("restore"),
                  confirmDelete: t("confirmDeleteLine"),
                  kindLabor: t("labor"),
                  kindPart: t("part"),
                  kindFee: t("fee"),
                  kindDiscount: t("discount"),
                }}
              />
            ))}
          </div>

          {/* Desktop table — fits the container, no horizontal scroll.
              Make / Model / Year collapsed into one "Vehicle" column
              ("Ford Focus 2014") to free width. Part / description gets
              the flex/auto column so it takes whatever remains; the
              numeric cells (Qty / Unit / Total) and the Type badge are
              tight + right-aligned. table-layout:auto lets the browser
              shrink the long description before the narrow numerics. */}
          <div className="hidden rounded-lg border border-border md:block">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-text-mute">
                <tr>
                  <th className="px-2 py-2 text-left">{t("colKind")}</th>
                  <th className="px-2 py-2 text-left">{t("colVehicle")}</th>
                  <th className="px-2 py-2 text-left">{t("colPart")}</th>
                  <th className="w-16 px-2 py-2 text-right">{t("colQty")}</th>
                  <th className="w-20 px-2 py-2 text-right">{t("colUnit")}</th>
                  <th className="w-24 px-2 py-2 text-right">{t("colTotal")}</th>
                  {editable || canDecline ? (
                    <th className="px-2 py-2 text-left">{t("colActions")}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {est.lines.map((l) => (
                  <EstimateLineRow
                    key={l.id}
                    estimateId={est.id}
                    editable={editable}
                    canDecline={canDecline}
                    vehicle={{
                      make: est.jobCard.vehicle.make,
                      model: est.jobCard.vehicle.model,
                      year: est.jobCard.vehicle.year,
                    }}
                    columnCount={editable || canDecline ? 7 : 6}
                    line={{
                      id: l.id,
                      kind: l.kind,
                      description: l.description,
                      qty: Number(l.qty),
                      unitPrice: Number(l.unitPrice),
                      lineTotal: Number(l.lineTotal),
                      declined: l.declined,
                    }}
                    displayDescription={translateLineDescription(l.description, locale)}
                    labels={{
                      edit: t("editLine"),
                      delete: t("deleteLine"),
                      save: t("saveLine"),
                      cancel: t("cancelLine"),
                      skip: t("skip"),
                      restore: t("restore"),
                      confirmDelete: t("confirmDeleteLine"),
                      kindLabor: t("labor"),
                      kindPart: t("part"),
                      kindFee: t("fee"),
                      kindDiscount: t("discount"),
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-mute">
          {t("noLineItems")}
        </p>
      )}

      <div className="ml-auto text-right text-base tabular-nums">
        <div className="text-zinc-600 dark:text-text-mute">{t("subtotal")}: {money(Number(est.subtotal))}</div>
        <div className="text-zinc-600 dark:text-text-mute">{t("vat5")}: {money(Number(est.vatAmount))}</div>
        <div className="mt-1 text-lg font-semibold">{t("total")}: {money(Number(est.total))}</div>
      </div>

      {editable ? (
        <form action={addEstimateLineAction} className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
          <input type="hidden" name="estimateId" value={est.id} />
          <div className="flex flex-wrap gap-2">
            <select name="kind" className="h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              <option value="LABOR">{t("labor")}</option>
              <option value="PART">{t("part")}</option>
              <option value="FEE">{t("fee")}</option>
              <option value="DISCOUNT">{t("discount")}</option>
            </select>
            <DictateInput locale={locale} labels={dictLabels} name="description" placeholder={t("description")} required className="min-w-40 flex-1 h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"/>
          </div>
          <div className="flex flex-wrap gap-2">
            <input name="qty" type="number" step="any" min="0" inputMode="decimal" defaultValue="1" className="w-20 rounded-md border border-black/15 bg-transparent px-3 py-2 text-base text-right dark:border-white/20"/>
            <input name="unitPrice" type="number" step="any" min="0" inputMode="decimal" placeholder="Unit price" required className="min-w-32 flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-base text-right dark:border-white/20"/>
            <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              {t("addLine")}
            </button>
          </div>
        </form>
      ) : null}

      {/* ─── Slice 6b: Advance payments ───────────────────────────
          Visible to cashier/owner once the estimate is APPROVED and
          before the invoice exists. Shows running totals against the
          SUM of all approved-estimate totals (so a re-estimate that
          raised the price doesn't suddenly make a prior advance look
          like an overpayment) and the audit list of advances. The
          form is hidden once the balance reaches 0 — no further
          advances can be taken once the approved total is covered. */}
      {canPrice && est.status ==="APPROVED"&& !est.invoice ? (
        (() => {
          const approvedTotal = est.jobCard.estimates.reduce(
            (s, e) => s + Number(e.total),
            0,
          );
          const advancePaid = est.jobCard.advancePayments.reduce(
            (s, a) => s + Number(a.amount),
            0,
          );
          const advanceBalance = balanceDue(approvedTotal, advancePaid);
          return (
            <section className="rounded-xl border border-warning-500/40 bg-warning-50 p-4 dark:border-warning-500/30 dark:bg-warning-500/10">
              <header className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-amber-900 dark:text-amber-200">
                  {t("advancePaymentsTitle")}
                </h2>
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {t("advancePaymentsCeiling")}: {money(approvedTotal)}
                </p>
              </header>
              {/* Running totals — same math as the invoice screen so
                  the cashier reads identical numbers across both
                  surfaces. balanceDue() guarantees
                  advancePaid + advanceBalance === approvedTotal. */}
              <dl className="mt-3 grid grid-cols-[max-content_max-content] gap-x-6 gap-y-1 text-sm tabular-nums">
                <dt className="text-zinc-700 dark:text-zinc-200">
                  {t("invoiceAdvancePaid")}
                </dt>
                <dd className="text-end">{money(advancePaid)}</dd>
                <dt className="font-semibold">{t("invoiceBalanceDue")}</dt>
                <dd className="text-end font-semibold">{money(advanceBalance)}</dd>
              </dl>
              {/* Audit list — each advance recorded individually, with
                  date and method, per spec 'full audit trail'. */}
              {est.jobCard.advancePayments.length > 0 ? (
                <ul className="mt-3 space-y-1 text-sm tabular-nums">
                  {est.jobCard.advancePayments.map((a) => (
                    <li
                      key={a.id}
                      className="flex justify-between gap-3 text-amber-900 dark:text-amber-200"
                    >
                      <span>
                        {a.receivedAt.toISOString().slice(0, 10)} ·{""}
                        {a.method ==="CASH"? t("methodCash") : t("methodCardPos")}
                      </span>
                      <span>{money(Number(a.amount))}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {/* Receive Advance Payment form — hidden once balance
                  is zero (no overpayment possible from the UI either,
                  the action still re-checks at the server). */}
              {advanceBalance > 0 ? (
                <form
                  action={recordAdvancePaymentAction}
                  className="mt-4 flex flex-wrap items-end gap-2"
                >
                  <input
                    type="hidden"
                    name="jobCardId"
                    value={est.jobCard.id}
                  />
                  <label className="flex flex-col text-xs text-amber-900 dark:text-amber-200">
                    {t("amount")}
                    <input
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={advanceBalance.toFixed(2)}
                      defaultValue={advanceBalance.toFixed(2)}
                      required
                      className="h-10 w-32 rounded-lg border border-border bg-surface px-3 text-right text-base text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                    />
                  </label>
                  <label className="flex flex-col text-xs text-amber-900 dark:text-amber-200">
                    {t("method")}
                    <select
                      name="method"
                      defaultValue="CASH"
                      className="h-10 rounded-lg border border-border bg-surface px-3 text-base text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                    >
                      <option value="CASH">{t("methodCash")}</option>
                      <option value="CARD_POS">{t("methodCardPos")}</option>
                    </select>
                  </label>
                  <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                    {t("receiveAdvancePayment")}
                  </button>
                </form>
              ) : (
                <p className="mt-3 text-sm text-amber-900 dark:text-amber-200">
                  ✓ {t("advancePaymentsFullyCovered")}
                </p>
              )}
            </section>
          );
        })()
      ) : null}

      {/* Lifecycle actions */}
      <div className="flex flex-wrap gap-2">
        {/* Preview gate — same pattern as the invoice flow. The cashier
            must review the customer-facing layout BEFORE the WhatsApp
            send (setEstimateStatusAction(SENT) here) goes out. The
            send action itself now only fires from
            /estimates/[id]/preview, so a typo noticed mid-edit can't
            slip into a one-tap send. */}
        {canPrice && est.status ==="DRAFT"&& est.lines.length > 0 ? (
          <Link
            href={`/estimates/${est.id}/preview`}
            className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            {t("estimatePreviewButton")}
          </Link>
        ) : null}
        {est.status ==="SENT"? (
          <>
            <StatusButton estimateId={est.id} status="APPROVED" label={t("markApproved")} primary />
            <StatusButton estimateId={est.id} status="REJECTED" label={t("markRejected")} />
          </>
        ) : null}
        {/* Generate Invoice — gated on jobCard.status === TECH_COMPLETE per
            spec, NOT on estimate.status === APPROVED alone. While the
            tech is still doing the work (job at APPROVED / REPAIR) the
            button is suppressed and a caption explains why. Once the
            tech taps Mark Complete the job flips to TECH_COMPLETE and
            the button reappears here AND in the cashier dashboard's
            'Awaiting final invoice' bucket. */}
        {canPrice && est.status ==="APPROVED"&& !est.invoice && jobStatus ==="TECH_COMPLETE"? (
          <form action={generateInvoiceAction}>
            <input type="hidden" name="estimateId" value={est.id} />
            <button className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              {t("generateInvoice")}
            </button>
          </form>
        ) : null}
        {est.invoice ? (
          <Link href={`/invoices/${est.invoice.id}`} className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
            {t("viewInvoice")}
          </Link>
        ) : null}
      </div>
      {/* Status caption visible WHILE the tech still has the car. Replaces
          the Generate-Invoice button per spec so the cashier sees an
          explicit 'why is there no button right now' message instead of
          guessing. */}
      {est.status ==="APPROVED"&& !est.invoice && workNotComplete ? (
        <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          {t("estimateApprovedSentToTech")}
        </p>
      ) : null}
      <p className="text-xs text-zinc-400">
        (Send/approve here simulates the customer; the real WhatsApp approval link is also sent on Send.)
      </p>
    </main>
  );
}

function StatusButton({
  estimateId,
  status,
  label,
  primary,
}: {
  estimateId: string;
  status: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <form action={setEstimateStatusAction}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="status" value={status} />
      <button
        className={
          primary
            ?"inline-flex h-12 items-center justify-center rounded-lg px-5 text-base font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            :"inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        }
      >
        {label}
      </button>
    </form>
  );
}
