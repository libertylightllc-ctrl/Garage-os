import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";

// Payables C6 (AR 2026-08-30). Suppliers owed money, sorted by
// outstanding DESC. Zero-balance suppliers hidden — this is a "who
// do I owe" screen, not a supplier directory (that's /owner/suppliers).
//
// OWNER + MASTER: payables sits on the operational MASTER-permitted
// side per AR's stated call ("Owner and master only"). Page guard
// matches the action guards on recordSupplierPaymentAction and
// voidSupplierBillAction (both requireOperational).

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function PayablesListPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const { error } = await searchParams;
  const garageId = session.user.garageId;

  // Pull every non-VOID bill for the garage, then group by supplier
  // and sum outstanding in JS. Small-N by design — MVP shops have
  // dozens of suppliers, not thousands, and Prisma's groupBy doesn't
  // help here because we need per-bill status + total + paidAmount
  // to compute the outstanding correctly.
  const bills = await prisma.supplierBill.findMany({
    where: { garageId, status: { not: "VOID" } },
    select: {
      supplierId: true,
      total: true,
      paidAmount: true,
      status: true,
      billDate: true,
      supplier: { select: { name: true } },
    },
    orderBy: { billDate: "desc" },
  });

  interface Row {
    supplierId: string;
    supplierName: string;
    outstanding: number;
    openBillCount: number;
    mostRecentBillDate: Date;
  }
  const bySupplier = new Map<string, Row>();
  for (const b of bills) {
    const outstanding = Number(b.total) - Number(b.paidAmount);
    const isOpen = b.status === "OPEN" || b.status === "PARTIALLY_PAID";
    const existing = bySupplier.get(b.supplierId);
    if (existing) {
      if (isOpen) {
        existing.outstanding += outstanding;
        existing.openBillCount += 1;
      }
      if (b.billDate > existing.mostRecentBillDate) {
        existing.mostRecentBillDate = b.billDate;
      }
    } else {
      bySupplier.set(b.supplierId, {
        supplierId: b.supplierId,
        supplierName: b.supplier.name,
        outstanding: isOpen ? outstanding : 0,
        openBillCount: isOpen ? 1 : 0,
        mostRecentBillDate: b.billDate,
      });
    }
  }
  const rows = Array.from(bySupplier.values())
    .filter((r) => r.outstanding > 0.005)
    .sort((a, b) => b.outstanding - a.outstanding);

  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 lg:max-w-6xl">
      <AppNav role={session.user.role as "OWNER" | "MASTER"} active="payables" />
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Payables</h1>
        <div className="text-right">
          <div className="text-xs text-text-mute">Total outstanding</div>
          <div className="text-xl font-semibold tabular-nums">{money(totalOutstanding)}</div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {error}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-text-mute">
          Nothing owed to any supplier right now.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-wide text-text-mute">
                <th className="px-4 py-2 text-start font-semibold">Supplier</th>
                <th className="px-4 py-2 text-end font-semibold">Open bills</th>
                <th className="px-4 py-2 text-end font-semibold">Last activity</th>
                <th className="px-4 py-2 text-end font-semibold">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.supplierId} className="border-b border-border/60 last:border-0 hover:bg-surface-2/30">
                  <td className="px-4 py-2.5 font-medium">
                    <Link href={`/owner/payables/${r.supplierId}`} className="hover:underline">
                      {r.supplierName}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-end tabular-nums text-text-mute">
                    {r.openBillCount}
                  </td>
                  <td className="px-4 py-2.5 text-end tabular-nums text-text-mute">
                    {r.mostRecentBillDate.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-2.5 text-end tabular-nums font-semibold">
                    {money(r.outstanding)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
