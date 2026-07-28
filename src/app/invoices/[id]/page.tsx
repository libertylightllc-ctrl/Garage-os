import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  addInvoiceLineAction,
  updateInvoiceLineAction,
  removeInvoiceLineAction,
  setInvoiceDiscountAction,
  emailInvoiceAction,
  // sendInvoiceToCustomerAction → /invoices/[id]/preview only.
  // recordPaymentAction → /cashier Receivables row only.
  // Both moved out so the edit page can only edit; mutations that
  // affect the customer (WhatsApp send) or the books (payment) live
  // on their own contextual surfaces.
} from "@/app/actions/billing";
import { PrintButton } from "@/components/print-button";
import { JobNumberBadge } from "@/components/job-number-badge";
import { DocumentHeader } from "@/components/document-header";
import { SendViaWhatsAppButton } from "@/components/SendViaWhatsAppButton";
import { normalizeToE164, buildWaMeUrl } from "@/lib/wa";
import { invoiceMessage } from "@/lib/po-message";
import { appUrl } from "@/lib/whatsapp";
// DISCOUNT_DESCRIPTION_MARKER moved out of billing.ts because that file
// is"use server"and can only export async functions — exporting a
// regexp from there broke the whole module under Turbopack on Vercel
// (every action came back as 'export not found'). Now imported from a
// plain module that both this page and billing.ts can share without
// triggering the server-action export check.
import { DISCOUNT_DESCRIPTION_MARKER } from "@/lib/invoice-discount";
import { arState, AR_EMOJI, balanceDue, formatInvoiceNo } from "@/lib/billing";
import { canEditInvoice } from "@/lib/permissions";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, fmtDateTime, countryToTimeZone } from "@/lib/format-datetime";
import { translateLineDescription } from "@/lib/line-item-translations";
import { WorkflowStepper } from "@/components/workflow-stepper";
import { workflowStage } from "@/lib/workflow-stage";
import { buildStepperLabels } from "@/lib/workflow-stepper-labels";
import { JobTimeline } from "@/components/job-timeline";
import { loadJobTimeline } from "@/lib/job-timeline-server";
import { buildTimelineLabels } from "@/lib/job-timeline-labels";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function InvoiceView({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // ?emailed=1 lights up the green 'Invoice emailed to customer'
  // confirmation banner after emailInvoiceAction redirects back.
  searchParams: Promise<{ emailed?: string }>;
}) {
  const { id } = await params;
  const { emailed } = await searchParams;
  const justEmailed = emailed ==="1";
  const session = await auth();
  if (!session?.user) redirect("/login");

  const inv = await prisma.invoice.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      lines: { orderBy: { createdAt:"asc"} },
      payments: true,
      garage: true,
      jobCard: { include: { vehicle: { include: { customer: true } } } },
    },
  });
  if (!inv) notFound();
  const tz = countryToTimeZone(inv.garage.country);
  const t = await getT();
  // locale drives the line-item dictionary swap below. Only the
  // read-only display branch uses translation; the inline-edit form
  // keeps the raw (English/canonical) description so the cashier
  // doesn't accidentally save translated text back to the DB.
  const locale = await getLocale();

  const total = Number(inv.total);
  const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  // Use the shared balanceDue helper so the invariant
  //  paid + balance == total
  // is preserved against floating-point noise the same way everywhere.
  const balance = balanceDue(total, paid);
  const state = arState(total, paid, inv.dueDate, new Date());
  const customer = inv.jobCard.vehicle.customer;

  // Workflow stepper — invoicePaid is just balance == 0 of THIS invoice
  // (we don't bother fetching a sibling here; cashier viewing one
  // invoice is viewing this job's invoice). latestEstimateStatus comes
  // from a small companion query.
  const latestEstimate = await prisma.estimate.findFirst({
    where: { jobCardId: inv.jobCardId },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  const stepperState = workflowStage({
    status: inv.jobCard.status,
    heldFrom: inv.jobCard.heldFrom,
    heldReason: inv.jobCard.holdReason,
    latestEstimateStatus: latestEstimate?.status ?? null,
    invoicePaid: paid >= total - 0.005,
  });
  const timelineEvents = await loadJobTimeline(inv.jobCardId, session.user.garageId);
  // Line edits are unlocked for cashier/owner only while the invoice
  // is still 'pre-send'. Once sendInvoiceToCustomerAction stamps
  // jobCard.invoiceSentAt the inputs disappear and the table falls
  // back to the existing read-only render (matches what the server-
  // side ownedEditableInvoice helper enforces).
  const canEditLines =
    canEditInvoice(session.user.role) && !inv.jobCard.invoiceSentAt;

  // Pull the discount line out of the main line array so the table
  // shows only real work + the totals area shows the discount as a
  // distinct row. There's at most one discount line — setInvoice
  // DiscountAction guarantees this by wiping any old discount line
  // before adding the new one. Marker pattern: 'Discount (...)' on
  // the description, stored as a FEE line with a negative amount.
  const discountLine = inv.lines.find((l) =>
    DISCOUNT_DESCRIPTION_MARKER.test(l.description),
  );
  const workLines = inv.lines.filter(
    (l) => !DISCOUNT_DESCRIPTION_MARKER.test(l.description),
  );
  // 'gross' = subtotal BEFORE discount (parts + labour only). Stored
  // invoice.subtotal already has the discount baked in — recompute
  // gross from the work-only lines so the totals area can show the
  // breakdown the user asked for.
  const grossSubtotal = workLines.reduce((s, l) => s + Number(l.lineTotal), 0);
  const discountAmount = discountLine ? Math.abs(Number(discountLine.lineTotal)) : 0;
  // Parse 'Discount (2%)' / 'Discount (fixed)' to render a small badge
  // showing which path the cashier used.
  const discountLabelKey = (() => {
    if (!discountLine) return null;
    const m = discountLine.description.match(/^Discount \((\d+(?:\.\d+)?)%\)/);
    if (m) return { mode:"PERCENT"as const, value: Number(m[1]) };
    return { mode:"AMOUNT"as const, value: discountAmount };
  })();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 lg:max-w-6xl xl:max-w-7xl print:max-w-full print:bg-white print:p-0 print:text-zinc-900">
      {/* Role-aware Back link — mirrors the /estimates/[id] pattern.
          Cashier (and owner) goes back to the Invoices tab of the
          dashboard; advisor goes back to the parent job. Tech doesn't
          normally land here. print:hidden so the customer's PDF
          doesn't carry a stray nav element. */}
      <Link
        href={
          session.user.role ==="ADVISOR"
            ? `/advisor/jobs/${inv.jobCardId}`
            :"/cashier?tab=invoices"
        }
        className="inline-block py-2 text-sm text-text-mute hover:underline print:hidden"
      >
        {session.user.role ==="ADVISOR"
          ? t("backJob")
          : t("invoiceBackToCashier")}
      </Link>

      {/* '?emailed=1' confirmation banner — green strip across the
          top, click-through to dismiss (just navigate without the
          searchParam). Hidden on print so it doesn't end up on the
          customer's PDF. */}
      {justEmailed ? (
        <div className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 print:hidden dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          📧 {t("invoiceEmailedConfirmation")}
        </div>
      ) : null}

      {/* Workflow stepper — hidden from print so the customer's PDF
          doesn't carry the internal progress UI. */}
      <div className="print:hidden">
        <WorkflowStepper state={stepperState} labels={buildStepperLabels(t)} />
      </div>

      {/* Action bar — Send via WhatsApp / Print Invoice / Print
          Receipt (when paid) / Email Invoice. All hidden from the
          print output so the document the customer sees is just the
          invoice itself. */}
      <div className="flex flex-wrap gap-2 print:hidden">
        {/* wa.me "Send via WhatsApp" — opens the staff's WhatsApp with
            the customer's number + a drafted message + a link to the
            customer-facing /c/invoice/{id} page. Staff hits Send from
            their own WhatsApp; this is the interim path until the
            shop connects the Cloud API (future upgrade, see wa.ts). */}
        {(() => {
          const phone = normalizeToE164(customer.waId ?? customer.phone);
          const msg = invoiceMessage({
            customer: { name: customer.name, lang: customer.lang },
            vehicle: { make: inv.jobCard.vehicle.make, model: inv.jobCard.vehicle.model },
            invoice: { total, number: inv.number },
            appUrl: appUrl(),
            invoiceId: inv.id,
          });
          return (
            <SendViaWhatsAppButton
              href={phone ? buildWaMeUrl(phone, msg) : null}
              label={t("waSend")}
              disabledReason={t("waSendDisabled")}
            />
          );
        })()}
        <PrintButton className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
          🖨️ {t("invoicePrintInvoice")}
        </PrintButton>
        {state ==="PAID"? (
          <Link
            href={`/invoices/${inv.id}/receipt`}
            target="_blank"
            rel="noopener"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            🧾 {t("invoicePrintReceipt")}
          </Link>
        ) : null}
        {canEditInvoice(session.user.role) ? (
          customer.email ? (
            <form action={emailInvoiceAction} className="contents">
              <input type="hidden" name="invoiceId" value={inv.id} />
              <button
                type="submit"
                className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
              >
                📧 {t("invoiceEmailInvoice")}
              </button>
            </form>
          ) : (
            <span
              aria-disabled="true"
              title={t("invoiceEmailNoEmailOnFile")}
              className="cursor-not-allowed rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-mute"
            >
              📧 {t("invoiceEmailNoEmailOnFile")}
            </span>
          )
        ) : null}
      </div>

      {/* Two-column layout at lg+ — invoice document (header, bill-to,
          line items, discount) reads as the primary canvas on the left;
          totals + QR + lifecycle actions + timeline sit in the right
          rail. Mobile keeps the single column. print:contents collapses
          the wrapper so the PDF print layout is unchanged. */}
      <div className="lg:grid lg:grid-cols-3 lg:gap-6 lg:items-start print:contents">
      <section className="flex min-w-0 flex-col gap-6 lg:col-span-2 print:contents">

      {/* Logo lives inside DocumentHeader now — see document-header.tsx.
          Standardized document header shared across every printable
          surface. Vehicle line uses the invoice's own jobCard.vehicle
          so the header's plate matches the customer's car exactly.
          Internal doc: fall back to the GarageOS mark. */}
      <DocumentHeader
        title={t("taxInvoice")}
        documentNumber={formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
        jobCard={inv.jobCard}
        vehicle={inv.jobCard.vehicle}
        garage={inv.garage}
        logoUrl={inv.garage.logoUrl ?? "/brand/garageos-logo.png"}
      />
      {/* Status pill row below the header — the four billing states
          (overdue / partial / paid) stay visible but drop out of the
          h1 line so the stacked header shape stays consistent across
          documents. Mutually exclusive by arState's precedence rules
          (overdue+partial → OVERDUE). */}
      {(state === "OVERDUE" || state === "PARTIAL" || state === "PAID") ? (
        <div className="mt-1 flex items-center gap-2">
          {state === "OVERDUE" ? (
            <span className="inline-flex items-center whitespace-nowrap rounded-full bg-danger-50 px-2 py-0.5 text-xs font-semibold text-danger-700 dark:bg-danger-500/10 dark:text-danger-500">
              {t("invoiceBadgeOverdue")}
            </span>
          ) : null}
          {state === "PARTIAL" ? (
            <span className="inline-flex items-center whitespace-nowrap rounded-full bg-warning-50 px-2 py-0.5 text-xs font-semibold text-warning-600 dark:bg-warning-500/10 dark:text-warning-500">
              {t("invoiceBadgePartial")}
            </span>
          ) : null}
          {state === "PAID" ? (
            <span className="inline-flex items-center whitespace-nowrap rounded-full bg-success-50 px-2 py-0.5 text-xs font-semibold text-success-700 dark:bg-success-500/10 dark:text-success-500">
              {t("invoiceBadgePaid")}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-between text-sm">
        <div>
          <div className="text-text-mute">{t("billTo")}</div>
          <div className="font-medium">{customer.name}</div>
          <div className="text-text-mute">{customer.phone}</div>
          <div className="text-text-mute">
            {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model} · {inv.jobCard.vehicle.plate}
            {inv.jobCard.number ? (
              <> · <JobNumberBadge jobCard={inv.jobCard} className="tabular-nums" /></>
            ) : null}
          </div>
        </div>
        <div className="text-right text-text-mute">
          <div>{t("issued")}: {fmtDate(inv.issuedAt, locale, tz)}</div>
          <div>{t("due")}: {fmtDate(inv.dueDate, locale, tz)}</div>
          <div>{t("clearance")}: {inv.clearanceStatus}</div>
        </div>
      </div>

      {/* Line-item editor — CSS subgrid layout.
          The header row, every editable row, and every read-only row
          all inherit ONE outer `gridTemplateColumns` definition via
          `grid-cols-subgrid` on their sub-row wrappers. That makes
          drift impossible: change a column width here and every row
          updates in lock-step. (Previous <table> + colSpan + inner
          flex grid drifted because the inner grid used different
          template widths from the table's colgroup.)
          overflow-x-auto on the outer wrapper preserves horizontal
          scroll on narrow phones (the inner grid is wider than 380px
          when all 5 cols are at their natural widths). On print,
          overflow-visible drops the scroll wrapper so the document
          lands clean on A4. */}
      <div className="overflow-x-auto print:overflow-visible">
        <div
          className="grid min-w-[36rem] text-sm tabular-nums"
          style={{
            // description=fill, qty=5rem, unit=6rem, amount=6rem,
            // action=auto. Header + editable + read-only rows all
            // inherit this via grid-cols-subgrid below.
            gridTemplateColumns:
            "minmax(8rem,1fr) 5rem 6rem 6rem auto",
          }}
        >
          {/* Header row */}
          <div className="col-span-full grid grid-cols-subgrid items-center gap-x-2 border-b border-border py-1 text-text-mute">
            <span className="px-2 text-start font-medium">{t("colDescription")}</span>
            <span className="px-2 text-end font-medium">{t("colQty")}</span>
            <span className="px-2 text-end font-medium">{t("colUnit")}</span>
            <span className="px-2 text-end font-medium">{t("colAmount")}</span>
            <span />
          </div>

          {workLines.map((l) =>
            canEditLines ? (
              // Inline edit row. The <form> uses `contents` so its
              // children (inputs + Save button) become DIRECT children
              // of the subgrid — they sit in the correct columns by
              // virtue of source order. Each input is 40px tall to
              // match the Workshop md control size; 16px text prevents
              // iOS Safari zoom on focus.
              <div
                key={l.id}
                className="col-span-full grid grid-cols-subgrid items-center gap-x-2 gap-y-1 border-b border-border py-2"
              >
                <form action={updateInvoiceLineAction} className="contents">
                  <input type="hidden" name="invoiceId" value={inv.id} />
                  <input type="hidden" name="lineId" value={l.id} />
                  <input type="hidden" name="kind" value={l.kind} />
                  <input
                    name="description"
                    defaultValue={l.description}
                    aria-label={t("colDescription")}
                    className="h-10 rounded-lg border border-border bg-transparent px-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                  />
                  <input
                    name="qty"
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    defaultValue={Number(l.qty)}
                    aria-label={t("colQty")}
                    className="h-10 rounded-lg border border-border bg-transparent px-2 text-end text-base tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                  />
                  <input
                    name="unitPrice"
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    defaultValue={Number(l.unitPrice).toFixed(2)}
                    aria-label={t("colUnit")}
                    className="h-10 rounded-lg border border-border bg-transparent px-2 text-end text-base tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                  />
                  <span className="px-2 text-end tabular-nums">
                    {Number(l.lineTotal).toFixed(2)}
                  </span>
                  <button
                    type="submit"
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-xs font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                  >
                    {t("saveDraft")}
                  </button>
                </form>
                {/* Remove ✕ — separate form on a sub-row below,
                    right-aligned across all 5 columns so the action
                    column reads cleanly as 'Save above, Remove below'
                    without crowding either button. */}
                <form
                  action={removeInvoiceLineAction}
                  className="col-span-full flex justify-end px-2"
                >
                  <input type="hidden" name="invoiceId" value={inv.id} />
                  <input type="hidden" name="lineId" value={l.id} />
                  <button
                    type="submit"
                    className="text-xs font-semibold text-danger-700 hover:underline dark:text-danger-500"
                    aria-label={t("removeLine")}
                  >
                    ✕ {t("removeLine")}
                  </button>
                </form>
              </div>
            ) : (
              <div
                key={l.id}
                className="col-span-full grid grid-cols-subgrid items-center gap-x-2 border-b border-border py-1"
              >
                <span className="px-2">{translateLineDescription(l.description, locale)}</span>
                <span className="px-2 text-end">{Number(l.qty)}</span>
                <span className="px-2 text-end">{Number(l.unitPrice).toFixed(2)}</span>
                <span className="px-2 text-end">{Number(l.lineTotal).toFixed(2)}</span>
                <span />
              </div>
            ),
          )}
        </div>
      </div>

      {canEditLines ? (
        // Add a new line — labor / part / fee selectable. Mirrors the
        // estimate-line add form so the cashier sees the same controls
        // they used while pricing the estimate. DISCOUNT short-circuits
        // to a negative FEE per the existing convention.
        <form
          action={addInvoiceLineAction}
          className="rounded-xl border border-border p-3 print:hidden"
        >
          <input type="hidden" name="invoiceId" value={inv.id} />
          <div className="mb-2 text-sm font-medium">{t("addLineTitle")}</div>
          <div className="grid grid-cols-[6rem_1fr_4.5rem_6rem_auto] items-center gap-2">
            <select
              name="kind"
              defaultValue="LABOR"
              className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
              aria-label={t("colKind")}
            >
              <option value="LABOR">{t("kindLabor")}</option>
              <option value="PART">{t("kindPart")}</option>
              <option value="FEE">{t("kindFee")}</option>
              <option value="DISCOUNT">{t("kindDiscount")}</option>
            </select>
            <input
              name="description"
              placeholder={t("colDescription")}
              className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <input
              name="qty"
              type="number"
              step="0.01"
              min="0"
              defaultValue="1"
              aria-label={t("colQty")}
              className="rounded-md border border-border bg-transparent px-2 py-1 text-end text-sm tabular-nums"
            />
            <input
              name="unitPrice"
              type="number"
              step="0.01"
              defaultValue="0"
              aria-label={t("colUnit")}
              className="rounded-md border border-border bg-transparent px-2 py-1 text-end text-sm tabular-nums"
            />
            <button
              type="submit"
              className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            >
              {t("addLineButton")}
            </button>
          </div>
        </form>
      ) : null}

      {/* Discount section — two side-by-side forms, one for % and one
          for a fixed AED amount. Whichever the cashier submits replaces
          the existing discount (setInvoiceDiscountAction wipes the prior
          discount line before writing the new one, so there's never
          stacking). A third 'Remove' form shows when a discount is
          already applied. Discount applies BEFORE VAT — handled in
          recomputeInvoice via the negative FEE line. */}
      {canEditLines ? (
        <div className="rounded-xl border border-border p-3 print:hidden">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t("discountSectionTitle")}</span>
            {discountLabelKey ? (
              <span className="text-xs text-danger-700 dark:text-danger-500">
                {discountLabelKey.mode ==="PERCENT"
                  ? t("discountCurrentPercent").replace(
                    "{pct}",
                      String(discountLabelKey.value),
                    )
                  : t("discountCurrentFixed").replace(
                    "{amount}",
                      money(discountLabelKey.value),
                    )}{""}
                · −{money(discountAmount)}
              </span>
            ) : (
              <span className="text-xs text-text-mute">
                {t("discountNone")}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <form
              action={setInvoiceDiscountAction}
              className="flex items-center gap-2 rounded-md border border-border p-2"
            >
              <input type="hidden" name="invoiceId" value={inv.id} />
              <input type="hidden" name="mode" value="PERCENT"/>
              <label className="text-xs text-text-mute">
                {t("discountPercentLabel")}
              </label>
              <input
                name="value"
                type="number"
                step="0.01"
                min="0"
                max="100"
                placeholder="2"
                aria-label={t("discountPercentLabel")}
                className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-end text-sm tabular-nums"
              />
              <span className="text-xs text-text-mute">%</span>
              <button
                type="submit"
                className="ms-auto inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
              >
                {t("discountApply")}
              </button>
            </form>
            <form
              action={setInvoiceDiscountAction}
              className="flex items-center gap-2 rounded-md border border-border p-2"
            >
              <input type="hidden" name="invoiceId" value={inv.id} />
              <input type="hidden" name="mode" value="AMOUNT"/>
              <label className="text-xs text-text-mute">
                {t("discountAmountLabel")}
              </label>
              <input
                name="value"
                type="number"
                step="0.01"
                min="0"
                placeholder="200"
                aria-label={t("discountAmountLabel")}
                className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-end text-sm tabular-nums"
              />
              <span className="text-xs text-text-mute">AED</span>
              <button
                type="submit"
                className="ms-auto inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
              >
                {t("discountApply")}
              </button>
            </form>
          </div>
          {discountLine ? (
            <form action={setInvoiceDiscountAction} className="mt-2 flex justify-end">
              <input type="hidden" name="invoiceId" value={inv.id} />
              <input type="hidden" name="mode" value="NONE"/>
              <input type="hidden" name="value" value="0"/>
              <button
                type="submit"
                className="text-xs text-danger-700 hover:underline"
              >
                ✕ {t("discountRemove")}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      </section>

      {/* Right rail — totals + QR, lifecycle (Send Invoice preview gate),
          and the audit timeline. On mobile this just stacks naturally
          (lg:mt-0 cancels the mt-6 spacer above the lg breakpoint). */}
      <aside className="mt-6 flex min-w-0 flex-col gap-6 lg:mt-0 print:contents">

      <div className="flex items-end justify-between">
        {/* QR placeholder — KSA Phase 2 replaces with a signed ZATCA QR */}
        <div className="flex flex-col items-center">
          <div className="grid h-24 w-24 place-items-center rounded-md border-2 border-dashed border-border text-[10px] text-text-mute">
            QR
          </div>
          <span className="mt-1 text-[10px] text-text-mute">{t("qrPlaceholder")}</span>
        </div>
        {/* Totals — per spec the order is strict:
              with discount:
                Subtotal (before discount)
                Discount    (single negative line, no % suffix)
                Subtotal (after discount)
                VAT (5%)    (calculated on subtotal AFTER discount)
                Total
              without discount:
                Subtotal
                VAT (5%)
                Total
            VAT correctness: invoice.vatAmount is computed by
            recomputeInvoice as 5% of invoice.subtotal, which already
            includes the negative discount line — so it matches 'VAT
            on subtotal AFTER discount' automatically. */}
        {/* Totals — definition list + CSS Grid for proper two-column
            alignment. Labels sit in column 1 (text-start), values in
            column 2 (text-end), so numbers right-align down the page
            and never collide with their labels. tabular-nums locks
            decimal positions so currency amounts of different lengths
            (e.g. 7.50 vs 1,890.00) still line up cleanly. */}
        <dl className="ml-auto grid grid-cols-[max-content_max-content] gap-x-6 gap-y-1 text-sm tabular-nums">
          {discountLine ? (
            <>
              <dt className="text-start text-text-mute">
                {t("subtotalBeforeDiscount")}
              </dt>
              <dd className="text-end">{money(grossSubtotal)}</dd>
              <dt className="text-start text-danger-700 dark:text-danger-500">
                {t("discountRow")}
              </dt>
              <dd className="text-end text-danger-700 dark:text-danger-500">
                −{money(discountAmount)}
              </dd>
              <dt className="text-start text-text-mute">
                {t("subtotalAfterDiscount")}
              </dt>
              <dd className="text-end">{money(Number(inv.subtotal))}</dd>
            </>
          ) : (
            <>
              <dt className="text-start text-text-mute">
                {t("subtotal")}
              </dt>
              <dd className="text-end">{money(grossSubtotal)}</dd>
            </>
          )}
          <dt className="text-start text-text-mute">
            {t("vat5")}
          </dt>
          <dd className="text-end">{money(Number(inv.vatAmount))}</dd>
          <dt className="text-start text-base font-semibold">{t("total")}</dt>
          <dd className="text-end text-base font-semibold">{money(total)}</dd>
          {/* Advance/Paid — slice 6. Hidden when paid==0 so a fresh
              invoice doesn't show a noisy '−AED 0.00' line. Negative
              sign communicates 'subtracted from total to get balance';
              the math invariant displayed is:
                Total − Advance/Paid == Balance Due
              which is the same invariant we test in billing.test.ts. */}
          {paid > 0 ? (
            <>
              <dt className="text-start text-text-mute">
                {state ==="PAID"? t("paid") : t("invoiceAdvancePaid")}
              </dt>
              <dd className="text-end text-text-mute">
                −{money(paid)}
              </dd>
            </>
          ) : null}
          {/* Balance Due — always shown, even at 0.00 when fully paid,
              so the printed/PDF render reads complete (cashier should
              see at-a-glance 'balance is zero, this is settled'). */}
          <dt className="text-start text-base font-semibold">
            {AR_EMOJI[state]} {t("invoiceBalanceDue")}
          </dt>
          <dd className="text-end text-base font-semibold">{money(balance)}</dd>
        </dl>
      </div>

      {/* Preview gate — replaces the direct Send-to-customer button per
          spec. The cashier must review the customer-facing render
          before the WhatsApp send goes out. The actual sendInvoice
          ToCustomerAction now only fires from /invoices/[id]/preview,
          which means typo'd line items can't reach the customer in
          one accidental click. */}
      {canEditInvoice(session.user.role) &&
      !inv.jobCard.invoiceSentAt ? (
        <Link
          href={`/invoices/${inv.id}/preview`}
          className="block rounded-xl border border-accent-500/40 bg-accent-50 p-4 text-center print:hidden dark:border-accent-500/30 dark:bg-accent-500/10"
        >
          <p className="text-sm text-brand-900 dark:text-accent-400">
            {t("invoicePreviewNote")}
          </p>
          <span className="mt-3 inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors">
            {t("invoicePreviewButton")}
          </span>
        </Link>
      ) : inv.jobCard.invoiceSentAt ? (
        <p className="rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-sm text-text-mute print:hidden">
          📨 {t("invoiceAlreadySent")} · {t("invoiceSentAt")}{""}
          {fmtDateTime(inv.jobCard.invoiceSentAt, locale, tz)}
        </p>
      ) : null}

      {/* Mark as Paid removed from this page per spec. Recording an
          actual customer payment now happens ONLY from the cashier's
          Receivables row on /cashier, so the cashier can't
          accidentally mark-paid while still editing line items here.
          The Receivables row has the same form (amount + method +
          Mark as Paid button) but lives next to the customer name +
          balance, which is the real context for a payment-record
          decision. */}

      {/* Audit timeline — print:hidden so the customer-facing PDF
          doesn't expose internal staff actions. */}
      <div className="print:hidden">
        <JobTimeline events={timelineEvents} labels={buildTimelineLabels(t)} />
      </div>

      </aside>
      </div>
    </main>
  );
}
