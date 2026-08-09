import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatInvoiceNo } from "@/lib/billing";
import { verifyToken } from "@/lib/tokens";
import { getT, getLocale } from "@/i18n/server";
import { translateLineDescription } from "@/lib/line-item-translations";
import { DocumentHeader } from "@/components/document-header";
import { UAE_VAT_RATE } from "@/lib/vat";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function CustomerInvoice({ params }: { params: Promise<{ id: string }> }) {
  const { id: token } = await params;
  const id = verifyToken("invoice", token);
  if (!id) notFound();
  const inv = await prisma.invoice.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { createdAt:"asc"} },
      payments: true,
      garage: true,
      // Pull customer for Bill-to block + FTA-required customer TRN when
      // set. Customer.trn was added to Customer for B2B invoices; the
      // customer is VAT-registered → we must print their TRN on the tax
      // invoice so they can reclaim the VAT.
      jobCard: { include: { vehicle: { include: { customer: true } } } },
    },
  });
  if (!inv) notFound();
  const t = await getT();
  // Customer-facing locale — when Arabic, swap known service names to
  // their Arabic equivalent via the dictionary (display only; stored
  // descriptions stay as the cashier typed them).
  const locale = await getLocale();

  const customer = inv.jobCard.vehicle.customer;
  const total = Number(inv.total);
  const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = Math.max(0, total - paid);
  const isPaid = inv.status ==="PAID"|| balance <= 0;

  // Per-line VAT — UAE VAT is a flat 5 % on VAT-exclusive line totals.
  // Rendered inline as an audit-friendly column rather than only the
  // aggregate at the bottom (FTA prefers per-line even at a single
  // rate; the aggregate stays as the total row for the customer).
  const lineVat = (lineTotal: number) =>
    Math.round((lineTotal * UAE_VAT_RATE + Number.EPSILON) * 100) / 100;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="flex flex-col items-start gap-3">
        {/* Customer-facing tax invoice.
            Title MUST be "Tax Invoice" per UAE FTA — it identifies the
            document type for both the customer and the tax audit.
            Logo: pass raw logoUrl; when null the header falls back to
            text-only garage name (never our brand on a customer's
            invoice). */}
        <DocumentHeader
          title={t("taxInvoice")}
          documentNumber={formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
          jobCard={inv.jobCard}
          vehicle={inv.jobCard.vehicle}
          garage={inv.garage}
          logoUrl={inv.garage.logoUrl}
        />
      </div>

      {/* Bill-to block — customer name and TRN (when present, VAT-
          registered). Customer TRN is labelled "Customer TRN" so it
          reads clearly as distinct from ours in the header. Phone is
          omitted from the customer's own invoice (not useful to them
          on a document they already have). */}
      <div className="text-sm">
        <div className="text-text-mute">{t("billTo")}</div>
        <div className="font-medium">{customer.name}</div>
        {/* Prefer the snapshot on the invoice row (frozen at
            generate time) over the live customer.trn — if the shop
            updated the customer's TRN after issuing this invoice,
            the historical document must still show what was issued.
            Falls through to the live value for invoices generated
            before the snapshot writer landed (they have null). */}
        {(inv.customerTrn ?? customer.trn) ? (
          <div className="text-text-mute">
            {t("customerTrnLabel")}: <span className="tabular-nums">{inv.customerTrn ?? customer.trn}</span>
          </div>
        ) : null}
      </div>

      {/* Line-item table — per-line VAT column added for FTA audit
          clarity. On a single-rate document the aggregate at the
          bottom is technically enough, but per-line matches FTA best
          practice and future-proofs for multi-rate lines. */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-text-mute">
            <tr>
              <th className="py-1 text-start font-medium">{t("colDescription")}</th>
              <th className="py-1 text-end font-medium tabular-nums">{t("colAmount")}</th>
              <th className="py-1 text-end font-medium tabular-nums">{t("colVat")}</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => {
              const amt = Number(l.lineTotal);
              return (
                <tr key={l.id} className="border-t border-border">
                  <td className="py-1 pe-2">{translateLineDescription(l.description, locale)}</td>
                  <td className="py-1 text-end tabular-nums">{amt.toFixed(2)}</td>
                  <td className="py-1 text-end tabular-nums">{lineVat(amt).toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border pt-2 text-right text-sm">
        <div>{t("subtotal")}: {money(Number(inv.subtotal))}</div>
        <div>{t("vat5")}: {money(Number(inv.vatAmount))}</div>
        <div className="text-lg font-semibold">{t("total")}: {money(total)}</div>
      </div>

      {isPaid ? (
        <p className="rounded-xl border border-success-500/40 bg-success-50 p-4 text-center text-sm font-semibold text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          {t("paidThanks")}
        </p>
      ) : (
        <p className="rounded-xl border border-border bg-surface-2 p-4 text-center text-sm">
          {t("payAtGarage")} · {money(balance)}
        </p>
      )}
    </main>
  );
}
