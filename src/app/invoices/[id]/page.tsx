import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { recordPaymentAction } from "@/app/actions/billing";
import { arState, AR_EMOJI, formatInvoiceNo } from "@/lib/billing";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function InvoiceView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const inv = await prisma.invoice.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      payments: true,
      garage: true,
      jobCard: { include: { vehicle: { include: { customer: true } } } },
    },
  });
  if (!inv) notFound();
  const t = await getT();

  const total = Number(inv.total);
  const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = Math.max(0, total - paid);
  const state = arState(total, paid, inv.dueDate, new Date());
  const customer = inv.jobCard.vehicle.customer;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("taxInvoice")}</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="font-medium">{inv.garage.name}</div>
          <div className="text-zinc-500 dark:text-zinc-400">TRN: {inv.garage.trn ?? "—"}</div>
          <div className="text-zinc-500 dark:text-zinc-400">{inv.garage.country}</div>
        </div>
      </div>

      <div className="flex justify-between text-sm">
        <div>
          <div className="text-zinc-500 dark:text-zinc-400">{t("billTo")}</div>
          <div className="font-medium">{customer.name}</div>
          <div className="text-zinc-500 dark:text-zinc-400">{customer.phone}</div>
          <div className="text-zinc-500 dark:text-zinc-400">
            {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model} · {inv.jobCard.vehicle.plate}
          </div>
        </div>
        <div className="text-right text-zinc-500 dark:text-zinc-400">
          <div>{t("issued")}: {inv.issuedAt.toISOString().slice(0, 10)}</div>
          <div>{t("due")}: {inv.dueDate.toISOString().slice(0, 10)}</div>
          <div>{t("clearance")}: {inv.clearanceStatus}</div>
        </div>
      </div>

      <div className="overflow-x-auto">
      <table className="w-full min-w-[20rem] text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/15">
            <th className="py-1">{t("colDescription")}</th>
            <th className="py-1 text-right">{t("colQty")}</th>
            <th className="py-1 text-right">{t("colUnit")}</th>
            <th className="py-1 text-right">{t("colAmount")}</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.id} className="border-b border-black/5 dark:border-white/10">
              <td className="py-1">{l.description}</td>
              <td className="py-1 text-right">{Number(l.qty)}</td>
              <td className="py-1 text-right">{Number(l.unitPrice).toFixed(2)}</td>
              <td className="py-1 text-right">{Number(l.lineTotal).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <div className="flex items-end justify-between">
        {/* QR placeholder — KSA Phase 2 replaces with a signed ZATCA QR */}
        <div className="flex flex-col items-center">
          <div className="grid h-24 w-24 place-items-center rounded-md border-2 border-dashed border-black/20 text-[10px] text-zinc-400 dark:border-white/20">
            QR
          </div>
          <span className="mt-1 text-[10px] text-zinc-400">{t("qrPlaceholder")}</span>
        </div>
        <div className="text-right text-sm">
          <div>{t("subtotal")}: {money(Number(inv.subtotal))}</div>
          <div>{t("vat5")}: {money(Number(inv.vatAmount))}</div>
          <div className="text-base font-semibold">{t("total")}: {money(total)}</div>
          <div className="mt-1">{t("paid")}: {money(paid)}</div>
          <div className="font-medium">
            {AR_EMOJI[state]} {state === "PAID" ? t("paid") : `${t("balance")} ${money(balance)}`}
          </div>
        </div>
      </div>

      {/* Accountants record payments here */}
      {session.user.role === "ACCOUNTANT" && state !== "PAID" ? (
        <form action={recordPaymentAction} className="flex items-end gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <input type="hidden" name="invoiceId" value={inv.id} />
          <label className="text-sm">
            {t("amount")}
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0"
              defaultValue={balance.toFixed(2)}
              className="mt-1 block w-32 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
          </label>
          <select name="method" className="rounded-md border border-black/15 bg-transparent px-2 py-2 text-sm dark:border-white/20">
            <option value="CASH">{t("methodCash")}</option>
            <option value="CARD">{t("methodCard")}</option>
            <option value="TRANSFER">{t("methodTransfer")}</option>
          </select>
          <button className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500">
            {t("recordPayment")}
          </button>
        </form>
      ) : null}
    </main>
  );
}
