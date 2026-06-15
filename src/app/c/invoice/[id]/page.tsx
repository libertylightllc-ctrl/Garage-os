import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatInvoiceNo } from "@/lib/billing";
import { verifyToken } from "@/lib/tokens";
import { getT, getLocale } from "@/i18n/server";
import { translateLineDescription } from "@/lib/line-item-translations";

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
   jobCard: { include: { vehicle: true } },
  },
 });
 if (!inv) notFound();
 const t = await getT();
 // Customer-facing locale — when Arabic, swap known service names to
 // their Arabic equivalent via the dictionary (display only; stored
 // descriptions stay as the cashier typed them).
 const locale = await getLocale();

 const total = Number(inv.total);
 const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
 const balance = Math.max(0, total - paid);
 const isPaid = inv.status ==="PAID"|| balance <= 0;

 return (
  <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
   <div>
    <p className="text-sm text-text-mute">{inv.garage.name}</p>
    <h1 className="text-2xl font-semibold tracking-tight">{t("yourInvoice")}</h1>
    <p className="text-sm text-text-mute">
     {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())} ·{""}
     {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model}
    </p>
   </div>

   <ul className="flex flex-col gap-1 text-sm">
    {inv.lines.map((l) => (
     <li key={l.id} className="flex justify-between">
      <span>{translateLineDescription(l.description, locale)}</span>
      <span>{Number(l.lineTotal).toFixed(2)}</span>
     </li>
    ))}
   </ul>
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
