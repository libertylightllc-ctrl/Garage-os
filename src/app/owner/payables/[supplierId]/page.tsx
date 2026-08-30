import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { PrintButton } from "@/components/print-button";
import { agingBuckets } from "@/lib/supplier-aging";
import { voidSupplierBillAction } from "@/app/actions/supplier-payments";
import { RecordPaymentForm } from "./pay-form";

// Payables C6 detail. One supplier's account: every bill and every
// payment for this supplier, chronologically, running balance,
// aging summary at top. Record-payment form below.
//
// OWNER + MASTER, matches the list page + the action guards.

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export default async function PayablesSupplierPage({
  params,
  searchParams,
}: {
  params: Promise<{ supplierId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const { supplierId } = await params;
  const { error } = await searchParams;

  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, garageId: session.user.garageId },
    select: { id: true, name: true },
  });
  if (!supplier) notFound();

  const bills = await prisma.supplierBill.findMany({
    where: { supplierId: supplier.id, garageId: session.user.garageId },
    orderBy: { billDate: "desc" },
    include: {
      allocations: {
        include: {
          supplierPayment: {
            select: { id: true, paidAt: true, method: true, amount: true, note: true },
          },
        },
      },
    },
  });

  // Aging (AR: from billDate, not createdAt).
  const aging = agingBuckets(
    bills.map((b) => ({
      billDate: b.billDate,
      total: Number(b.total),
      paidAmount: Number(b.paidAmount),
      status: b.status,
    })),
  );

  // Chronological event feed — bills as one row per issue, payments
  // (via allocations) as one row per PAYMENT (aggregated across its
  // allocations to THIS supplier's bills), newest first. A payment
  // that hits two bills for this supplier still shows once here with
  // its total amount to this supplier.
  interface FeedRow {
    kind: "bill" | "payment";
    date: Date;
    label: string;
    detail: string;
    amount: number; // positive on bill (owed), negative on payment (out)
    billId?: string;
    billStatus?: string;
    canVoid?: boolean;
  }
  const feed: FeedRow[] = [];
  for (const b of bills) {
    const status = b.status;
    const canVoid = status === "OPEN" && b.allocations.length === 0;
    feed.push({
      kind: "bill",
      date: b.billDate,
      label: `BILL-${String(b.billNumber).padStart(4, "0")}`,
      detail:
        (b.supplierInvoiceRef ? `Supplier: ${b.supplierInvoiceRef} · ` : "") +
        `Status: ${status}` +
        (Number(b.paidAmount) > 0 ? ` · Paid ${money(Number(b.paidAmount))}` : ""),
      amount: Number(b.total),
      billId: b.id,
      billStatus: status,
      canVoid,
    });
  }
  const paymentAgg = new Map<string, { amount: number; paidAt: Date; method: string; note: string | null }>();
  for (const b of bills) {
    for (const a of b.allocations) {
      const p = a.supplierPayment;
      if (!paymentAgg.has(p.id)) {
        paymentAgg.set(p.id, { amount: 0, paidAt: p.paidAt, method: p.method, note: p.note });
      }
      paymentAgg.get(p.id)!.amount += Number(a.amount);
    }
  }
  for (const [, p] of paymentAgg.entries()) {
    feed.push({
      kind: "payment",
      date: p.paidAt,
      label: `Payment · ${p.method}`,
      detail: p.note ?? "",
      amount: -p.amount,
    });
  }
  feed.sort((a, b) => b.date.getTime() - a.date.getTime());

  // Running balance forward-in-time: iterate oldest → newest,
  // accumulate. Then we present newest → oldest with balance-at-time
  // annotated.
  const chronological = [...feed].reverse();
  let running = 0;
  const balanceById = new Map<number, number>();
  chronological.forEach((row, i) => {
    running = Math.round((running + row.amount) * 100) / 100;
    balanceById.set(i, running);
  });
  const feedWithBalance = chronological
    .map((row, i) => ({ ...row, balanceAfter: balanceById.get(i) ?? 0 }))
    .reverse();

  // Open bills for the record-payment form.
  const openBillsForForm = bills
    .filter((b) => b.status === "OPEN" || b.status === "PARTIALLY_PAID")
    .map((b) => ({
      id: b.id,
      billNumber: b.billNumber,
      billDate: isoDate(b.billDate),
      supplierInvoiceRef: b.supplierInvoiceRef,
      outstanding: Number(b.total) - Number(b.paidAmount),
    }));

  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <main
      data-print-document="supplier-statement"
      className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 lg:max-w-6xl print:max-w-none print:p-0"
    >
      <div className="print:hidden">
        <AppNav role={session.user.role as "OWNER" | "MASTER"} active="payables" />
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-xs text-text-mute print:hidden">
            <Link href="/owner/payables" className="hover:underline">Payables</Link>
            {" › "}
            {supplier.name}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {supplier.name}
            <span className="ms-2 hidden text-base font-normal text-text-mute print:inline">
              — Supplier Statement
            </span>
          </h1>
          <div className="mt-1 hidden text-xs text-text-mute print:block">
            Generated {todayIso}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-text-mute">Total outstanding</div>
            <div className="text-xl font-semibold tabular-nums">{money(aging.total)}</div>
          </div>
          <PrintButton className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-sm font-medium hover:bg-surface-2 print:hidden">
            🖨 Print
          </PrintButton>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500 print:hidden">
          {error}
        </div>
      ) : null}

      {/* Aging summary — ages from billDate per AR 2026-08-30 hard req.
          Consistent 4-bucket shape with the customer-side aging on
          the /owner dashboard so both sides read the same way. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Current (0-30d)", value: aging.current },
          { label: "31-60 days", value: aging.days30 },
          { label: "61-90 days", value: aging.days60 },
          { label: "91+ days", value: aging.days90plus },
        ].map((cell, i) => (
          <div
            key={i}
            className={`rounded-xl border p-3 ${i >= 2 ? "border-amber-500/30" : "border-border"}`}
          >
            <div className="text-xs text-text-mute">{cell.label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{money(cell.value)}</div>
          </div>
        ))}
      </div>

      {/* Chronological ledger — bills + payments, newest first, with
          running balance. Void action inline on bills that qualify
          (OPEN with no allocations). */}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-wide text-text-mute">
              <th className="px-3 py-2 text-start font-semibold">Date</th>
              <th className="px-3 py-2 text-start font-semibold">Entry</th>
              <th className="px-3 py-2 text-end font-semibold">Amount</th>
              <th className="px-3 py-2 text-end font-semibold">Balance</th>
              <th className="px-3 py-2 text-end font-semibold print:hidden" />
            </tr>
          </thead>
          <tbody>
            {feedWithBalance.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-text-mute">
                  No activity yet.
                </td>
              </tr>
            ) : (
              feedWithBalance.map((row, i) => (
                <tr key={i} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2 tabular-nums text-text-mute">{isoDate(row.date)}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.label}</div>
                    {row.detail ? (
                      <div className="text-xs text-text-mute">{row.detail}</div>
                    ) : null}
                  </td>
                  <td
                    className={`px-3 py-2 text-end tabular-nums font-medium ${row.amount < 0 ? "text-emerald-700 dark:text-emerald-400" : ""}`}
                  >
                    {row.amount < 0 ? `−${money(-row.amount)}` : money(row.amount)}
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums text-text-mute">
                    {money(row.balanceAfter)}
                  </td>
                  <td className="px-3 py-2 text-end print:hidden">
                    {row.canVoid && row.billId ? (
                      <form action={voidSupplierBillAction}>
                        <input type="hidden" name="billId" value={row.billId} />
                        <button
                          type="submit"
                          className="rounded-md border border-border px-2 py-1 text-xs text-text-mute hover:bg-surface-2 hover:text-text"
                        >
                          Void
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Record-payment form (client component for live allocation
          math + submit-disabled UX). Hidden when there are no open
          bills to allocate against. Print-hidden — the printable
          statement is a document a shop hands a supplier, not an
          input surface. */}
      <div className="print:hidden">
        {openBillsForForm.length > 0 ? (
          <RecordPaymentForm
            supplierId={supplier.id}
            supplierName={supplier.name}
            openBills={openBillsForForm}
            todayIso={todayIso}
          />
        ) : (
          <div className="rounded-xl border border-border bg-surface p-4 text-center text-sm text-text-mute">
            No open bills. Nothing to pay right now.
          </div>
        )}
      </div>
    </main>
  );
}
