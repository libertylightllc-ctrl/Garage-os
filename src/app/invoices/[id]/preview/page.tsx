import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendInvoiceToCustomerAction } from "@/app/actions/billing";
import { balanceDue, formatInvoiceNo } from "@/lib/billing";
import { CustomerPhoneNudge } from "@/components/customer-phone-nudge";
import { normalizeToE164 } from "@/lib/wa";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, fmtDateTime, countryToTimeZone } from "@/lib/format-datetime";
import { DISCOUNT_DESCRIPTION_MARKER } from "@/lib/invoice-discount";
import { canEditInvoice } from "@/lib/permissions";
import { JobNumberBadge } from "@/components/job-number-badge";
import { DocumentHeader } from "@/components/document-header";
import { InvoiceLineSection } from "@/components/invoice-line-section";
import { groupLinesBySection } from "@/lib/estimate-sections";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
  * Cashier-only preview of the customer-facing invoice render.
  *
  * Inserted per spec between the edit page and the WhatsApp send so the
  * cashier sees the formatted layout BEFORE the customer does. From
  * here they can:
  *  • Go Back → /invoices/[id]  (continue editing)
  *  • Send to Customer → fires sendInvoiceToCustomerAction (the only
  *            place this action is wired now).
  *
  * Read-only. No edit forms here so an accidental tap can't mutate
  * line items right before sending — the preview literally is what
  * the customer is about to receive.
  */
export default async function InvoicePreview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Same role gate as the send action itself — preview is only
  // useful for the staff who can actually send.
  if (!canEditInvoice(session.user.role)) {
    redirect(`/invoices/${id}`);
  }

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
  const locale = await getLocale();

  // Discount handling mirrors the edit page: pull the discount line
  // out of the table and show it as a single negative row in the
  // totals area. The marker is a regex on description.
  const discountLine = inv.lines.find((l) =>
    DISCOUNT_DESCRIPTION_MARKER.test(l.description),
  );
  const workLines = inv.lines.filter(
    (l) => !DISCOUNT_DESCRIPTION_MARKER.test(l.description),
  );
  const grossSubtotal = workLines.reduce((s, l) => s + Number(l.lineTotal), 0);
  // AR 2026-08-25 Batch D — same three-section restructure as Batch C
  // gave the estimate. Discount lines are already pulled out by the
  // DISCOUNT_DESCRIPTION_MARKER regex above, so this only buckets the
  // real work lines; any stray FEE-negative row that slipped past the
  // marker would still land in the section helper's discount bucket
  // and be omitted from the section tables (we render them into the
  // totals block instead, unchanged).
  const invoiceSections = groupLinesBySection(
    workLines.map((l) => ({
      id: l.id,
      kind: l.kind,
      description: l.description,
      qty: Number(l.qty),
      unitPrice: Number(l.unitPrice),
      lineTotal: Number(l.lineTotal),
    })),
  );
  const discountAmount = discountLine
    ? Math.abs(Number(discountLine.lineTotal))
    : 0;
  const total = Number(inv.total);
  // Slice 6 — mirror /invoices/[id]: if advance payments have been
  // recorded already, the preview the cashier is about to send must
  // also show them, otherwise the customer sees 'Total: 982.54' with
  // no acknowledgement of the 300 they paid yesterday.
  const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = balanceDue(total, paid);
  const customer = inv.jobCard.vehicle.customer;
  // AR 2026-08-23 — soft nudge above the Send button when the
  // customer's phone can't be normalised. See sibling comment on
  // the estimate preview page.
  const customerPhoneRaw = customer.waId ?? customer.phone ?? null;
  const customerPhoneWillPrefill = normalizeToE164(customerPhoneRaw) !== null;
  // 2026-08-10 timestamp split: the Send button hides once the
  // customer has confirmed-DELIVERED the invoice. A wa.me hand-off
  // by itself (invoiceSentAt set, invoiceDeliveredAt null) is
  // recoverable — the operator can re-open the WhatsApp draft, so
  // we let them preview + resend rather than freezing the flow.
  const alreadyDelivered = Boolean(inv.jobCard.invoiceDeliveredAt);
  const handedOff = Boolean(inv.jobCard.invoiceSentAt);

  return (
    // Centered max-width container with a card-like surface so the
    // preview reads as a discrete"document". White background even
    // in dark mode to approximate the WhatsApp / PDF rendering the
    // customer will see.
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <div className="rounded-2xl border border-black/10 bg-white p-8 text-zinc-900 shadow-sm dark:border-white/20 dark:shadow-none">
        {/* Header — Tax Invoice + per-garage invoice number + garage
            identity + TRN. Matches the existing /invoices/[id] read-
            only render so the cashier preview is faithful. */}
        {/* Standardized document header — INV-… + JC-… + vehicle + plate
            on the start side, garage identity on the end side. Same
            shape as /invoices/[id] so the cashier preview reads as a
            faithful render of the invoice they're about to send. */}
        {/* Cashier's preview of the customer-facing invoice. Internal
            surface — fall back to the GarageOS mark. */}
        <DocumentHeader
          title={t("taxInvoice")}
          documentNumber={formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
          jobCard={inv.jobCard}
          vehicle={inv.jobCard.vehicle}
          vinLabel={t("documentVinLabel")}
          garage={inv.garage}
          logoUrl={inv.garage.logoUrl ?? "/brand/garageos-logo.png"}
        />

        <div className="mt-6 flex justify-between text-sm">
          <div>
            <div className="text-zinc-500">{t("billTo")}</div>
            <div className="font-medium">{customer.name}</div>
            <div className="text-zinc-500">{customer.phone}</div>
            {/* Customer TRN — FTA requirement when the customer is
                VAT-registered. Snapshot on the invoice wins over
                the live customer field so the preview faithfully
                shows what will be printed / sent. */}
            {(inv.customerTrn ?? customer.trn) ? (
              <div className="text-zinc-500">
                {t("customerTrnLabel")}:{" "}
                <span className="tabular-nums">{inv.customerTrn ?? customer.trn}</span>
              </div>
            ) : null}
            <div className="text-zinc-500">
              {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model} ·{""}
              {inv.jobCard.vehicle.plate}
              {inv.jobCard.number ? (
                <> · <JobNumberBadge jobCard={inv.jobCard} className="tabular-nums" /></>
              ) : null}
            </div>
          </div>
          <div className="text-right text-zinc-500">
            <div>
              {t("issued")}: {fmtDate(inv.issuedAt, locale, tz)}
            </div>
            <div>
              {t("due")}: {fmtDate(inv.dueDate, locale, tz)}
            </div>
            <div>
              {t("clearance")}: {inv.clearanceStatus}
            </div>
          </div>
        </div>

        {/* Line items — work-only (parts/labour/fees). Discount lives
            in the totals area, not as a row, per spec. */}
        {/* AR 2026-08-25 Batch D — sectioned line-items, same three-
            section shape as the estimate: Parts, Sublet/Consumables/
            Services, Labour. Each section has its own subtotal row.
            Empty sections are omitted (the caller gates on
            lines.length > 0 inside InvoiceLineSection). Discount
            lines stay pulled out via DISCOUNT_DESCRIPTION_MARKER and
            render in the totals block below. */}
        <div className="mt-6 flex flex-col gap-6 print:overflow-visible">
          {workLines.length === 0 ? (
            <p className="py-3 text-center text-zinc-500">{t("noLineItems")}</p>
          ) : (
            <>
              <InvoiceLineSection
                title={t("estimateSectionParts")}
                lines={invoiceSections.parts.lines}
                subtotal={invoiceSections.parts.subtotal}
                locale={locale}
                t={t}
                vatRate={0.05}
              />
              <InvoiceLineSection
                title={t("estimateSectionSublet")}
                lines={invoiceSections.sublet.lines}
                subtotal={invoiceSections.sublet.subtotal}
                locale={locale}
                t={t}
                vatRate={0.05}
              />
              <InvoiceLineSection
                title={t("estimateSectionLabour")}
                lines={invoiceSections.labour.lines}
                subtotal={invoiceSections.labour.subtotal}
                locale={locale}
                t={t}
                vatRate={0.05}
              />
            </>
          )}
        </div>

        {/* Totals — same breakdown as the edit page, mirroring the
            customer-facing view exactly:
              with discount  → before / discount / after / VAT / total
              without     → subtotal / VAT / total
            VAT is invoice.vatAmount (already 5% of post-discount
            subtotal via recomputeInvoice). */}
        <div className="mt-6 flex items-end justify-between">
          {/* QR placeholder hidden from print — the dashed "QR" box
              is dead ink until KSA Phase 2 renders a real image from
              qrPayload. See src/app/invoices/[id]/page.tsx for the
              full note. (AR 2026-08-14.) */}
          <div className="flex flex-col items-center print:hidden">
            <div className="grid h-24 w-24 place-items-center rounded-md border-2 border-dashed border-black/20 text-[10px] text-zinc-400">
              QR
            </div>
            <span className="mt-1 text-[10px] text-zinc-400">
              {t("qrPlaceholder")}
            </span>
          </div>
          <dl className="grid grid-cols-[max-content_max-content] gap-x-6 gap-y-1 text-sm tabular-nums">
            {discountLine ? (
              <>
                <dt className="text-start text-zinc-600">
                  {t("subtotalBeforeDiscount")}
                </dt>
                <dd className="text-end">{money(grossSubtotal)}</dd>
                <dt className="text-start text-rose-700">
                  {t("discountRow")}
                </dt>
                <dd className="text-end text-rose-700">
                  −{money(discountAmount)}
                </dd>
                <dt className="text-start text-zinc-600">
                  {t("totalGrossLabel")}
                </dt>
                <dd className="text-end">{money(Number(inv.subtotal))}</dd>
              </>
            ) : (
              <>
                <dt className="text-start text-zinc-600">{t("totalGrossLabel")}</dt>
                <dd className="text-end">{money(grossSubtotal)}</dd>
              </>
            )}
            <dt className="text-start text-zinc-600">{t("totalVatLabel")}</dt>
            <dd className="text-end">{money(Number(inv.vatAmount))}</dd>
            <dt className="text-start text-base font-semibold">{t("totalNetLabel")}</dt>
            <dd className="text-end text-base font-semibold">{money(total)}</dd>
            {/* Advance/Paid + Balance Due — slice 6. Only render when
                payments have already been recorded; an unsent invoice
                with no prior advance shows the clean Total row alone. */}
            {paid > 0 ? (
              <>
                <dt className="text-start text-zinc-600">
                  {paid >= total ? t("paid") : t("invoiceAdvancePaid")}
                </dt>
                <dd className="text-end text-zinc-600">−{money(paid)}</dd>
                <dt className="text-start text-base font-semibold">
                  {t("invoiceBalanceDue")}
                </dt>
                <dd className="text-end text-base font-semibold">
                  {money(balance)}
                </dd>
              </>
            ) : null}
          </dl>
        </div>

        {/* AR 2026-08-25 — parity with Estimate. Remarks block first
            (full-width), then payment terms + advisor grid, matching
            the estimate preview layout exactly. All optional; each
            block omits cleanly when its data is null. */}
        {inv.remarks?.trim() ? (
          // AR 2026-08-25 Batch F2.7 — yellow fill (print-safe).
          <div className="mt-6 rounded border border-yellow-400 bg-yellow-100 px-3 py-2 text-sm text-zinc-900 [-webkit-print-color-adjust:exact] [print-color-adjust:exact]">
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-700">
              {t("estimateRemarksHeading")}
            </div>
            <p className="mt-1 whitespace-pre-line">{inv.remarks}</p>
          </div>
        ) : null}

        {(() => {
          // Batch F1/F2 — trim-guard all three so a whitespace-only
          // field can never render a heading with nothing meaningful
          // under it (AR: "a heading rendering with nothing under it
          // is worse than omitting the block").
          const paymentTerms = (inv.paymentTerms?.trim() || inv.garage.defaultPaymentTerms?.trim()) || null;
          const advisorName = inv.advisorNameSnapshot?.trim() || null;
          const advisorPhone = inv.advisorPhoneSnapshot?.trim() || null;
          if (!paymentTerms && !advisorName) return null;
          return (
            <div className="mt-8 grid grid-cols-1 gap-4 border-t border-zinc-200 pt-4 text-sm sm:grid-cols-2">
              {paymentTerms ? (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
                    {t("estimatePaymentTermsHeading")}
                  </div>
                  <p className="mt-1 whitespace-pre-line">{paymentTerms}</p>
                </div>
              ) : <div />}
              {advisorName ? (
                <div className="sm:text-end">
                  <div className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
                    {t("estimateAdvisorHeading")}
                  </div>
                  <div className="mt-1 font-medium">{advisorName}</div>
                  {advisorPhone ? (
                    <div className="text-sm text-zinc-700 tabular-nums">{advisorPhone}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })()}

        {/* AR 2026-08-25 Batch D — shop-wide Terms & Conditions,
            bottom of the printable doc so it prints with the
            invoice. Renders only when set; blank = no block. */}
        {inv.garage.invoiceTerms ? (
          <div className="mt-6 border-t border-zinc-200 pt-4 text-xs">
            <div className="font-semibold uppercase tracking-wide text-zinc-600">
              {t("documentTermsHeading")}
            </div>
            <p className="mt-1 whitespace-pre-line leading-relaxed">
              {inv.garage.invoiceTerms}
            </p>
          </div>
        ) : null}
      </div>

      {/* Bottom action bar — three states after the 2026-08-10
          timestamp split:
            1. Nothing sent yet          → Send via WhatsApp button.
            2. Handed off, NOT delivered → Resend button + amber
               note explaining the operator still needs to press Send
               in WhatsApp (the wa.me draft is still open). Preview
               remains reachable, so re-preview + re-hand-off is safe.
            3. Delivered (Meta webhook)  → grey "delivered" pill; no
               resend. Corrections need void & correct. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href={`/invoices/${inv.id}`}
          className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-center text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        >
          {t("invoicePreviewGoBack")}
        </Link>
        {alreadyDelivered ? (
          <p className="rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-sm text-text-mute">
            ✅ {t("invoiceDeliveredBanner")} ·{""}
            {fmtDateTime(inv.jobCard.invoiceDeliveredAt!, locale, tz)}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {!customerPhoneWillPrefill ? (
              <CustomerPhoneNudge
                rawPhone={customerPhoneRaw}
                labels={{
                  heading: t("phoneNudgeHeading"),
                  rawLabel: t("phoneNudgeRawLabel"),
                  rawNone: t("phoneNudgeRawNone"),
                }}
              />
            ) : null}
            <form action={sendInvoiceToCustomerAction}>
              <input type="hidden" name="invoiceId" value={inv.id} />
              <button
                type="submit"
                className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
              >
                {handedOff ? t("invoiceResendViaWhatsApp") : t("sendInvoiceToCustomer")}
              </button>
            </form>
          </div>
        )}
      </div>

      {/* Footer note — three states matching the CTA above. */}
      {alreadyDelivered ? null : handedOff ? (
        <p className="rounded-xl border border-warning-500/40 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
          📱 {t("invoiceHandedOffBanner")} · {t("invoiceSentAt")}{" "}
          {fmtDateTime(inv.jobCard.invoiceSentAt!, locale, tz)}
        </p>
      ) : (
        <p className="text-xs text-zinc-400">{t("invoicePreviewMockNote")}</p>
      )}
    </main>
  );
}
