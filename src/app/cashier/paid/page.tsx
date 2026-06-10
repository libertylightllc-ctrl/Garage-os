import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { arState, formatInvoiceNo } from "@/lib/billing";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
 * Cashier → Paid Invoices archive.
 *
 * The main /cashier dashboard only surfaces UNPAID invoices in its
 * Receivables block so the staff see active work only. Once an invoice
 * goes fully paid it drops off the dashboard and lives here.
 *
 * Columns per spec: Customer, Vehicle, Amount, VAT, Paid on, Method.
 * Sorted newest-payment-first so the most recent settlement is on top.
 */
export default async function PaidInvoices() {
  const session = await requireRole("CASHIER");
  const t = await getT();
  const garageId = session.user.garageId;

  // Pull invoices + payments + customer chain. We can't filter
  // "paid in full" at the SQL level cleanly (compare sum(payments) to
  // total per row), so we read all invoices for the garage and
  // categorise in JS — same arState helper the receivables block uses.
  const invoices = await prisma.invoice.findMany({
    where: { garageId },
    include: {
      payments: { orderBy: { paidAt: "desc" } },
      jobCard: {
        include: { vehicle: { include: { customer: true } } },
      },
    },
    orderBy: { issuedAt: "desc" },
  });

  const now = new Date();
  const paidRows = invoices
    .map((inv) => {
      const total = Number(inv.total);
      const paidTotal = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const state = arState(total, paidTotal, inv.dueDate, now);
      // Most recent payment timestamp + method drive the visible
      // "Paid on" + "Method" columns. payments are already orderBy desc.
      const latest = inv.payments[0];
      return {
        inv,
        total,
        vat: Number(inv.vatAmount),
        state,
        paidAt: latest?.paidAt ?? null,
        method: latest?.method ?? null,
      };
    })
    .filter((r) => r.state === "PAID")
    // Re-sort by latest-payment date desc; we already sorted by
    // issuedAt above, but a back-dated payment on an older invoice
    // should still surface near the top.
    .sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0));

  const methodLabel = (m: string | null) => {
    if (m === "CASH") return t("methodCash");
    if (m === "CARD_POS") return t("methodCardPos");
    return m ?? "—";
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      <AppNav role="CASHIER" active="accounts" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("paidInvoicesTitle")}</h1>
        <Link
          href="/cashier"
          className="rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {t("paidInvoicesBack")}
        </Link>
      </div>

      {paidRows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("paidInvoicesEmpty")}</p>
      ) : (
        // Table on wider screens; falls back to a stacked card list on
        // small phones so the cashier can still scan paid jobs without
        // horizontal scrolling. Headers are i18n + RTL-friendly.
        <>
          <ul className="flex flex-col gap-2 sm:hidden">
            {paidRows.map(({ inv, total, vat, paidAt, method }) => (
              <li
                key={inv.id}
                className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
              >
                <Link href={`/invoices/${inv.id}`} className="block hover:underline">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())} ·{" "}
                      {inv.jobCard.vehicle.customer.name}
                    </span>
                    <span className="tabular-nums font-semibold">{money(total)}</span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model} ·{" "}
                    {inv.jobCard.vehicle.plate}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-600 dark:text-zinc-300">
                    <span>{t("colVat")} {money(vat)}</span>
                    <span>
                      {t("colDatePaid")}{" "}
                      {paidAt ? paidAt.toISOString().slice(0, 10) : "—"}
                    </span>
                    <span>
                      {t("colMethod")}: {methodLabel(method)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-lg border border-black/10 sm:block dark:border-white/15">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-zinc-600 dark:bg-zinc-900/40 dark:text-zinc-300">
                <tr className="text-start">
                  <th className="p-2 text-start font-medium">{t("colCustomer")}</th>
                  <th className="p-2 text-start font-medium">{t("colVehicle")}</th>
                  <th className="p-2 text-end font-medium">{t("colAmount")}</th>
                  <th className="p-2 text-end font-medium">{t("colVat")}</th>
                  <th className="p-2 text-start font-medium">{t("colDatePaid")}</th>
                  <th className="p-2 text-start font-medium">{t("colMethod")}</th>
                </tr>
              </thead>
              <tbody>
                {paidRows.map(({ inv, total, vat, paidAt, method }) => (
                  <tr
                    key={inv.id}
                    className="border-t border-black/10 hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
                  >
                    <td className="p-2">
                      <Link href={`/invoices/${inv.id}`} className="hover:underline">
                        <div className="font-medium">
                          {inv.jobCard.vehicle.customer.name}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
                        </div>
                      </Link>
                    </td>
                    <td className="p-2">
                      <div>
                        {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        {inv.jobCard.vehicle.plate}
                      </div>
                    </td>
                    <td className="p-2 text-end tabular-nums">{money(total)}</td>
                    <td className="p-2 text-end tabular-nums">{money(vat)}</td>
                    <td className="p-2 tabular-nums">
                      {paidAt ? paidAt.toISOString().slice(0, 10) : "—"}
                    </td>
                    <td className="p-2">{methodLabel(method)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
