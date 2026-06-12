import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendInvoiceToCustomerAction } from "@/app/actions/billing";
import { formatInvoiceNo } from "@/lib/billing";
import { getT } from "@/i18n/server";
import { DISCOUNT_DESCRIPTION_MARKER } from "@/lib/invoice-discount";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
 * Cashier-only preview of the customer-facing invoice render.
 *
 * Inserted per spec between the edit page and the WhatsApp send so the
 * cashier sees the formatted layout BEFORE the customer does. From
 * here they can:
 *   • Go Back  → /invoices/[id]   (continue editing)
 *   • Send to Customer → fires sendInvoiceToCustomerAction (the only
 *                       place this action is wired now).
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
  if (!["CASHIER", "OWNER"].includes(session.user.role)) {
    redirect(`/invoices/${id}`);
  }

  const inv = await prisma.invoice.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      garage: true,
      jobCard: { include: { vehicle: { include: { customer: true } } } },
    },
  });
  if (!inv) notFound();
  const t = await getT();

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
  const customer = inv.jobCard.vehicle.customer;
  const alreadySent = Boolean(inv.jobCard.invoiceSentAt);

  return (
    // Centered max-width container with a card-like surface so the
    // preview reads as a discrete "document". White background even
    // in dark mode to approximate the WhatsApp / PDF rendering the
    // customer will see.
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <div className="rounded-2xl border border-black/10 bg-white p-8 text-zinc-900 shadow-sm dark:border-white/20 dark:shadow-none">
        {/* Header — Tax Invoice + per-garage invoice number + garage
            identity + TRN. Matches the existing /invoices/[id] read-
            only render so the cashier preview is faithful. */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("taxInvoice")}
            </h1>
            <p className="text-sm text-zinc-500">
              {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
            </p>
          </div>
          <div className="text-right text-sm">
            <div className="font-medium">{inv.garage.name}</div>
            <div className="text-zinc-500">TRN: {inv.garage.trn ?? "—"}</div>
            <div className="text-zinc-500">{inv.garage.country}</div>
          </div>
        </div>

        <div className="mt-6 flex justify-between text-sm">
          <div>
            <div className="text-zinc-500">{t("billTo")}</div>
            <div className="font-medium">{customer.name}</div>
            <div className="text-zinc-500">{customer.phone}</div>
            <div className="text-zinc-500">
              {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model} ·{" "}
              {inv.jobCard.vehicle.plate}
            </div>
          </div>
          <div className="text-right text-zinc-500">
            <div>
              {t("issued")}: {inv.issuedAt.toISOString().slice(0, 10)}
            </div>
            <div>
              {t("due")}: {inv.dueDate.toISOString().slice(0, 10)}
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
              <col className="w-16" />
              <col className="w-24" />
              <col className="w-28" />
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
                  <td className="px-2 py-1">{l.description}</td>
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
              with discount   → before / discount / after / VAT / total
              without         → subtotal / VAT / total
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
          className="rounded-lg border border-black/15 px-5 py-3 text-center text-base font-semibold hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {t("invoicePreviewGoBack")}
        </Link>
        {alreadySent ? (
          <p className="rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            📨 {t("invoiceAlreadySent")} ·{" "}
            {inv.jobCard.invoiceSentAt!.toISOString().slice(0, 16).replace("T", " ")}
          </p>
        ) : (
          <form action={sendInvoiceToCustomerAction}>
            <input type="hidden" name="invoiceId" value={inv.id} />
            <button
              type="submit"
              className="rounded-lg bg-fuchsia-600 px-5 py-3 text-base font-semibold text-white hover:bg-fuchsia-500"
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
