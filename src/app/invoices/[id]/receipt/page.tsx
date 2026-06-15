import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatInvoiceNo } from "@/lib/billing";
import { getT } from "@/i18n/server";
import { AutoPrint } from "@/components/auto-print";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
 * Print-receipt route. Auto-fires the browser print dialog on load
 * so the cashier opens this in a new tab and immediately gets the
 * Print / Save-as-PDF dialog.
 *
 * Content per spec: amount paid, date, payment method, invoice
 * number, balance. Plus a small garage-identity header and
 * customer name so the receipt stands alone as proof of payment.
 *
 * No app chrome (AppNav, sign-out, etc.). The whole page IS the
 * printable surface. White background, black text — looks the same
 * on screen and on paper.
 */
export default async function InvoiceReceipt({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const inv = await prisma.invoice.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      payments: { orderBy: { paidAt: "desc" } },
      garage: true,
      jobCard: { include: { vehicle: { include: { customer: true } } } },
    },
  });
  if (!inv) notFound();
  const t = await getT();

  // Only one receipt rendered per page — show the latest payment.
  // If there were multiple payments (none in the current model, but
  // defending), we use the most recent. A future 'partial payments'
  // slice could render one receipt per payment.
  const latestPayment = inv.payments[0];
  const total = Number(inv.total);
  const paidTotal = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = Math.max(0, total - paidTotal);
  const methodLabel =
    latestPayment?.method === "CASH"
      ? t("methodCash")
      : latestPayment?.method === "CARD_POS"
        ? t("methodCardPos")
        : (latestPayment?.method ?? "—");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-white p-8 text-zinc-900">
      <AutoPrint />

      {/* Back to invoice — visible on screen only. print:hidden so it
          doesn't appear on the customer's receipt PDF. Lets the
          cashier escape if they cancel the print dialog or land here
          via a direct URL. */}
      <Link
        href={`/invoices/${inv.id}`}
        className="inline-block text-sm text-zinc-500 hover:underline print:hidden"
      >
        {t("invoiceBackToInvoice")}
      </Link>

      {/* Header: garage identity + RECEIPT label so the customer
          immediately knows what this paper is. */}
      <div className="flex items-start justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("invoiceReceiptTitle")}
          </h1>
          <p className="text-sm text-zinc-500">
            {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="font-medium">{inv.garage.name}</div>
          <div className="text-zinc-500">TRN: {inv.garage.trn ?? "—"}</div>
        </div>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-zinc-500">{t("invoiceReceiptCustomer")}</dt>
        <dd>{inv.jobCard.vehicle.customer.name}</dd>

        <dt className="text-zinc-500">{t("invoiceReceiptInvoiceNumber")}</dt>
        <dd className="tabular-nums">
          {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
        </dd>

        <dt className="text-zinc-500">{t("invoiceReceiptAmountPaid")}</dt>
        <dd className="tabular-nums font-semibold">
          {money(Number(latestPayment?.amount ?? 0))}
        </dd>

        <dt className="text-zinc-500">{t("invoiceReceiptDate")}</dt>
        <dd className="tabular-nums">
          {latestPayment
            ? latestPayment.paidAt.toISOString().slice(0, 10)
            : "—"}
        </dd>

        <dt className="text-zinc-500">{t("invoiceReceiptMethod")}</dt>
        <dd>{methodLabel}</dd>

        <dt className="text-zinc-500">{t("invoiceReceiptBalance")}</dt>
        <dd className="tabular-nums font-semibold">{money(balance)}</dd>

        <dt className="text-zinc-500">{t("invoiceReceiptTotal")}</dt>
        <dd className="tabular-nums">{money(total)}</dd>
      </dl>

      <p className="border-t border-border pt-4 text-center text-xs text-text-mute">
        {t("invoiceReceiptThanks")}
      </p>
    </main>
  );
}
