import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendInvoiceToCustomerAction } from "@/app/actions/billing";
import { balanceDue, formatInvoiceNo } from "@/lib/billing";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, fmtDateTime, countryToTimeZone } from "@/lib/format-datetime";
import { DISCOUNT_DESCRIPTION_MARKER } from "@/lib/invoice-discount";
import { translateLineDescription } from "@/lib/line-item-translations";
import { canEditInvoice } from "@/lib/permissions";
import { JobNumberBadge } from "@/components/job-number-badge";
import { DocumentHeader } from "@/components/document-header";

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
  const alreadySent = Boolean(inv.jobCard.invoiceSentAt);

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
        <DocumentHeader
          title={t("taxInvoice")}
          documentNumber={formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
          jobCard={inv.jobCard}
          vehicle={inv.jobCard.vehicle}
          garage={inv.garage}
        />

        <div className="mt-6 flex justify-between text-sm">
          <div>
            <div className="text-zinc-500">{t("billTo")}</div>
            <div className="font-medium">{customer.name}</div>
            <div className="text-zinc-500">{customer.phone}</div>
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
        {/* Same column-alignment fix as /invoices/[id]: colgroup for
            fixed numeric column widths, px-2 padding so numbers never
            touch, tabular-nums for decimal alignment. Preview is what
            the cashier reviews before sending — and it's printable
            too (Ctrl+P works anywhere) so it must hold up on paper. */}
        <div className="mt-6 overflow-x-auto print:overflow-visible">
          <table className="w-full text-sm tabular-nums">
            <colgroup>
              <col />
              <col className="w-16"/>
              <col className="w-24"/>
              <col className="w-28"/>
            </colgroup>
            <thead>
              <tr className="border-b border-black/10 text-zinc-500">
                <th className="px-2 py-1 text-start font-medium">{t("colDescription")}</th>
                <th className="px-2 py-1 text-end font-medium">{t("colQty")}</th>
                <th className="px-2 py-1 text-end font-medium">{t("colUnit")}</th>
                <th className="px-2 py-1 text-end font-medium">{t("colAmount")}</th>
              </tr>
            </thead>
            <tbody>
              {workLines.map((l) => (
                <tr key={l.id} className="border-b border-black/5">
                  <td className="px-2 py-1">{translateLineDescription(l.description, locale)}</td>
                  <td className="px-2 py-1 text-end">{Number(l.qty)}</td>
                  <td className="px-2 py-1 text-end">
                    {Number(l.unitPrice).toFixed(2)}
                  </td>
                  <td className="px-2 py-1 text-end">
                    {Number(l.lineTotal).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals — same breakdown as the edit page, mirroring the
            customer-facing view exactly:
              with discount  → before / discount / after / VAT / total
              without     → subtotal / VAT / total
            VAT is invoice.vatAmount (already 5% of post-discount
            subtotal via recomputeInvoice). */}
        <div className="mt-6 flex items-end justify-between">
          <div className="flex flex-col items-center">
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
                  {t("subtotalAfterDiscount")}
                </dt>
                <dd className="text-end">{money(Number(inv.subtotal))}</dd>
              </>
            ) : (
              <>
                <dt className="text-start text-zinc-600">{t("subtotal")}</dt>
                <dd className="text-end">{money(grossSubtotal)}</dd>
              </>
            )}
            <dt className="text-start text-zinc-600">{t("vat5")}</dt>
            <dd className="text-end">{money(Number(inv.vatAmount))}</dd>
            <dt className="text-start text-base font-semibold">{t("total")}</dt>
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
      </div>

      {/* Bottom action bar — Go Back and Send to Customer side by side.
          'Send to Customer' is the ONLY surface in the app that calls
          sendInvoiceToCustomerAction now, so the cashier is guaranteed
          to have seen this layout before the WhatsApp send goes out.
          Once invoiceSentAt is stamped, the Send button is replaced
          by a 'already sent' notice so a back-button + re-tap can't
          re-fire the send. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href={`/invoices/${inv.id}`}
          className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-center text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        >
          {t("invoicePreviewGoBack")}
        </Link>
        {alreadySent ? (
          <p className="rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-sm text-text-mute">
            📨 {t("invoiceAlreadySent")} ·{""}
            {fmtDateTime(inv.jobCard.invoiceSentAt!, locale, tz)}
          </p>
        ) : (
          <form action={sendInvoiceToCustomerAction}>
            <input type="hidden" name="invoiceId" value={inv.id} />
            <button
              type="submit"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            >
              {t("sendInvoiceToCustomer")}
            </button>
          </form>
        )}
      </div>

      {/* Mock-note footer — only relevant pre-send. After invoiceSentAt
          is stamped, the note reads as if Send to Customer is still a
          live action ('logs the message that would have gone out'), so
          hide it then. The 'Invoice already sent' notice above replaces
          it. */}
      {!alreadySent ? (
        <p className="text-xs text-zinc-400">{t("invoicePreviewMockNote")}</p>
      ) : null}
    </main>
  );
}
