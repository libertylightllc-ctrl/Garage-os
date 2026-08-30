"use client";

// Payables C6 client — record-payment form with live allocation
// running total. AR's rule: an operator hitting the sum-equals-amount
// invariant on the server should understand why BEFORE they submit,
// not after. Client shows the running allocated total against the
// payment amount as they type and disables submit until they match.
// The server-side invariant in recordSupplierPaymentAction remains
// the real control — this is UX, not a security boundary.

import { useMemo, useState } from "react";
import { recordSupplierPaymentAction } from "@/app/actions/supplier-payments";

interface OpenBill {
    id: string;
    billNumber: number;
    billDate: string; // ISO YYYY-MM-DD, formatted server-side
    supplierInvoiceRef: string | null;
    outstanding: number; // total - paidAmount
}

interface Props {
    supplierId: string;
    supplierName: string;
    openBills: OpenBill[];
    todayIso: string; // server-computed YYYY-MM-DD for the date picker default
}

const money = (n: number) => `AED ${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

function toNumber(raw: string): number {
    const s = raw.trim();
    if (s === "") return 0;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function RecordPaymentForm({ supplierId, supplierName, openBills, todayIso }: Props) {
    const [amountRaw, setAmountRaw] = useState("");
    const [allocations, setAllocations] = useState<Record<string, string>>({});

    const amount = round2(toNumber(amountRaw));
    const allocatedSum = round2(
        openBills.reduce((s, b) => s + toNumber(allocations[b.id] ?? ""), 0),
    );
    const diff = round2(amount - allocatedSum);
    const matches = amount > 0 && diff === 0;
    const hasAnyAllocation = allocatedSum > 0;

    // Over-allocated on a specific bill? Highlight it — same rule the
    // server enforces (per-bill cap), but caught client-side so the
    // operator sees it before hitting submit.
    const overByBill = useMemo(() => {
        const m: Record<string, boolean> = {};
        for (const b of openBills) {
            const a = toNumber(allocations[b.id] ?? "");
            if (a > b.outstanding + 0.005) m[b.id] = true;
        }
        return m;
    }, [allocations, openBills]);
    const anyOverAllocation = Object.values(overByBill).some(Boolean);

    const setAlloc = (billId: string, v: string) =>
        setAllocations((prev) => ({ ...prev, [billId]: v }));

    // "Distribute" convenience: fill each bill from top to bottom
    // until the payment amount is exhausted.
    const distribute = () => {
        let remaining = amount;
        const next: Record<string, string> = {};
        for (const b of openBills) {
            if (remaining <= 0) {
                next[b.id] = "";
                continue;
            }
            const alloc = Math.min(remaining, b.outstanding);
            next[b.id] = alloc.toFixed(2);
            remaining = round2(remaining - alloc);
        }
        setAllocations(next);
    };

    const submitDisabled = !matches || anyOverAllocation || !amountRaw.trim();

    return (
        <form action={recordSupplierPaymentAction} className="space-y-3 rounded-xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-base font-semibold">Record payment to {supplierName}</h2>
            </div>
            <input type="hidden" name="supplierId" value={supplierId} />

            <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Amount</span>
                    <input
                        name="amount"
                        type="number"
                        step="0.01"
                        min="0"
                        required
                        value={amountRaw}
                        onChange={(e) => setAmountRaw(e.target.value)}
                        className="rounded-md border border-border bg-transparent px-2 py-1.5 text-right tabular-nums"
                    />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Method</span>
                    <select
                        name="method"
                        required
                        defaultValue="Bank Transfer"
                        className="rounded-md border border-border bg-transparent px-2 py-1.5"
                    >
                        <option value="Cash">Cash</option>
                        <option value="Bank Transfer">Bank Transfer</option>
                        <option value="Card">Card</option>
                        <option value="Cheque">Cheque</option>
                        <option value="Other">Other</option>
                    </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Paid at</span>
                    <input
                        name="paidAt"
                        type="date"
                        defaultValue={todayIso}
                        className="rounded-md border border-border bg-transparent px-2 py-1.5"
                    />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Note (optional)</span>
                    <input
                        name="note"
                        type="text"
                        maxLength={200}
                        className="rounded-md border border-border bg-transparent px-2 py-1.5"
                    />
                </label>
            </div>

            <div className="rounded-lg border border-border/60 bg-surface-2/40 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">Allocate across bills</div>
                    <button
                        type="button"
                        onClick={distribute}
                        disabled={amount <= 0}
                        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Distribute
                    </button>
                </div>
                {openBills.length === 0 ? (
                    <p className="text-sm text-text-mute">No open bills to allocate against.</p>
                ) : (
                    <div className="space-y-1.5">
                        {openBills.map((b) => (
                            <div
                                key={b.id}
                                className={`flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm ${overByBill[b.id] ? "bg-danger-50 dark:bg-danger-500/10" : ""}`}
                            >
                                <span className="min-w-0 truncate">
                                    <span className="font-medium">BILL-{String(b.billNumber).padStart(4, "0")}</span>
                                    <span className="ms-2 text-xs text-text-mute">
                                        {b.billDate}
                                        {b.supplierInvoiceRef ? ` · ${b.supplierInvoiceRef}` : ""}
                                        {" · outstanding "}
                                        <span className="tabular-nums font-medium text-text">
                                            {money(b.outstanding)}
                                        </span>
                                    </span>
                                </span>
                                <input
                                    name={`alloc_${b.id}`}
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    max={b.outstanding}
                                    placeholder="0.00"
                                    value={allocations[b.id] ?? ""}
                                    onChange={(e) => setAlloc(b.id, e.target.value)}
                                    aria-invalid={overByBill[b.id] || undefined}
                                    className={`w-28 shrink-0 rounded-md border bg-transparent px-2 py-1 text-right tabular-nums ${overByBill[b.id] ? "border-danger-500" : "border-border"}`}
                                />
                            </div>
                        ))}
                    </div>
                )}
                <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border/60 pt-2 text-sm">
                    <span className="text-text-mute">Allocated</span>
                    <span
                        className={`tabular-nums font-semibold ${
                            !hasAnyAllocation
                                ? "text-text-mute"
                                : matches
                                    ? "text-emerald-700 dark:text-emerald-400"
                                    : "text-amber-700 dark:text-amber-400"
                        }`}
                    >
                        {money(allocatedSum)} / {money(amount)}
                        {amount > 0 && !matches ? (
                            <span className="ms-2 text-xs font-normal">
                                {diff > 0
                                    ? `(${money(diff)} left to allocate)`
                                    : `(${money(-diff)} over — reduce allocation)`}
                            </span>
                        ) : null}
                    </span>
                </div>
            </div>

            {anyOverAllocation ? (
                <p className="text-xs text-danger-700 dark:text-danger-500">
                    One or more allocations exceed the bill&apos;s outstanding balance. Reduce them to record the payment.
                </p>
            ) : null}

            <div className="flex justify-end">
                <button
                    type="submit"
                    disabled={submitDisabled}
                    className="inline-flex items-center rounded-lg bg-brand-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
                >
                    Record payment
                </button>
            </div>
        </form>
    );
}
