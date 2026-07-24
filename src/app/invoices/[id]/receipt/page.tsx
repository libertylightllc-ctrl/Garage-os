import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatInvoiceNo } from "@/lib/billing";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { AutoPrint } from "@/components/auto-print";
import { JobNumberBadge } from "@/components/job-number-badge";
import { DocumentHeader } from "@/components/document-header";

export const dynamic ="force-dynamic";

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
      payments: { orderBy: { paidAt:"desc"} },
      garage: true,
      jobCard: { include: { vehicle: { include: { customer: true } } } },
    },
  });
  if (!inv) notFound();
  const tz = countryToTimeZone(inv.garage.country);
  const t = await getT();
  const locale = await getLocale();

  // Only one receipt rendered per page — show the latest payment.
  // If there were multiple payments (none in the current model, but
  // defending), we use the most recent. A future 'partial payments'
  // slice could render one receipt per payment.
  const latestPayment = inv.payments[0];
  const total = Number(inv.total);
  const paidTotal = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = Math.max(0, total - paidTotal);
  const methodLabel =
    latestPayment?.method ==="CASH"
      ? t("methodCash")
      : latestPayment?.method ==="CARD_POS"
        ? t("methodCardPos")
        : (latestPayment?.method ??"—");

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

      {/* Standardized document header. Same stacked shape as
          /invoices/[id] and /invoices/[id]/preview so the receipt
          reads as part of the same document family. Border stays on
          the wrapper below the header. */}
      <div className="border-b border-border pb-4">
        {/* Print-receipt route. Auto-fires the Ctrl+P dialog on load
            so the eager-loaded logo prop matters here more than most
            surfaces — a lazy logo would print blank on the first pass. */}
        <DocumentHeader
          title={t("invoiceReceiptTitle")}
          documentNumber={formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
          jobCard={inv.jobCard}
          vehicle={inv.jobCard.vehicle}
          garage={inv.garage}
          logoUrl={inv.garage.logoUrl ?? "/brand/garageos-logo.png"}
        />
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-zinc-500">{t("invoiceReceiptCustomer")}</dt>
        <dd>{inv.jobCard.vehicle.customer.name}</dd>

        <dt className="text-zinc-500">{t("invoiceReceiptInvoiceNumber")}</dt>
        <dd className="tabular-nums">
          {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
        </dd>

        {inv.jobCard.number ? (
          <>
            <dt className="text-zinc-500">{t("handoffJobNo")}</dt>
            <dd className="tabular-nums">
              <JobNumberBadge jobCard={inv.jobCard} />
            </dd>
          </>
        ) : null}

        <dt className="text-zinc-500">{t("invoiceReceiptAmountPaid")}</dt>
        <dd className="tabular-nums font-semibold">
          {money(Number(latestPayment?.amount ?? 0))}
        </dd>

        <dt className="text-zinc-500">{t("invoiceReceiptDate")}</dt>
        <dd className="tabular-nums">
          {latestPayment ? fmtDate(latestPayment.paidAt, locale, tz) :"—"}
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
