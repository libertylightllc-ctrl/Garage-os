import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { arState, AR_EMOJI, formatInvoiceNo, ACCOUNTS } from "@/lib/billing";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function AccountantHome() {
  const session = await requireRole("ACCOUNTANT");
  const garageId = session.user.garageId;

  const [invoices, ledger] = await Promise.all([
    prisma.invoice.findMany({
      where: { garageId },
      include: { payments: true, jobCard: { include: { vehicle: { include: { customer: true } } } } },
      orderBy: { issuedAt: "desc" },
    }),
    prisma.ledgerEntry.findMany({ where: { garageId } }),
  ]);

  // Zero-entry ledger rollup (auto-generated rows; nothing entered by hand).
  const byAccount = new Map<string, number>();
  for (const e of ledger) {
    byAccount.set(e.account, (byAccount.get(e.account) ?? 0) + Number(e.debit) - Number(e.credit));
  }
  const revenue = -(byAccount.get(ACCOUNTS.SALES) ?? 0); // credit-normal
  const vatCollected = -(byAccount.get(ACCOUNTS.VAT_PAYABLE) ?? 0);
  const cash = byAccount.get(ACCOUNTS.CASH) ?? 0; // debit-normal
  const arOutstanding = byAccount.get(ACCOUNTS.AR) ?? 0; // debit-normal

  const now = new Date();

  const metrics = [
    { label: "Revenue", value: revenue },
    { label: "VAT collected", value: vatCollected },
    { label: "Cash in", value: cash },
    { label: "AR outstanding", value: arOutstanding },
  ];

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ACCOUNTANT" active="accounts" />
      <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-lg border border-black/10 p-3 dark:border-white/15">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{m.label}</div>
            <div className="text-lg font-semibold">{money(m.value)}</div>
          </div>
        ))}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium">Receivables</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No invoices yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {invoices.map((inv) => {
              const total = Number(inv.total);
              const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
              const state = arState(total, paid, inv.dueDate, now);
              return (
                <li key={inv.id}>
                  <Link
                    href={`/invoices/${inv.id}`}
                    className="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                  >
                    <span>
                      <span className="font-medium">{AR_EMOJI[state]} {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}</span>
                      <span className="ml-2 text-zinc-500 dark:text-zinc-400">
                        {inv.jobCard.vehicle.customer.name}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block">{money(total)}</span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {state === "PAID" ? "paid" : `due ${inv.dueDate.toISOString().slice(0, 10)}`}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs text-zinc-400">
        All figures are generated from auto-posted ledger entries — no manual bookkeeping.
      </p>
    </main>
  );
}
