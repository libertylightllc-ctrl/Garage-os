"use client";

// E1f — Total + VAT inputs with live subtotal derivation.
// AR 2026-09-02: form makes the split obvious rather than arithmetic
// the operator does in their head. Same shape as the payment
// allocation counter — refuse-before-submit when the numbers don't
// add up (vatAmount > total).
//
// Contract:
//   name="total"     → gross amount that left the shop (required, > 0)
//   name="vatAmount" → reclaimable input VAT (optional, defaults 0)
//
// Client-side does NOT sanitize away invalid input — it only surfaces
// the mismatch. The server action still validates the same invariant
// (recordExpenseAction refuses vatAmount > total) so a scripted
// submit can't bypass this.

import { useState } from "react";

function fmt(n: number): string {
    if (!Number.isFinite(n)) return "AED 0.00";
    return `AED ${n.toFixed(2)}`;
}

export function ExpenseAmountFields() {
    const [total, setTotal] = useState<string>("");
    // Zero-default is deliberate (AR 2026-09-02) — auto-calc from
    // Garage.vatRate would silently claim reclaimable VAT on SALARIES /
    // BANK_CHARGES / any exempt-in-practice category, corrupting
    // Form 201 more than a missing entry does. Operator has to type
    // a non-zero to assert it.
    const [vat, setVat] = useState<string>("0");

    const totalNum = total === "" ? 0 : Number(total);
    const vatNum = vat === "" ? 0 : Number(vat);
    const subtotalNum = Math.round((totalNum - vatNum) * 100) / 100;

    const totalValid = total !== "" && Number.isFinite(totalNum) && totalNum > 0;
    const vatValid = Number.isFinite(vatNum) && vatNum >= 0;
    const invariantHolds = totalValid && vatValid && vatNum <= totalNum;
    const showMismatch =
        totalValid && vatValid && vatNum > totalNum;

    return (
        <>
            <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">
                    Amount (AED)
                    <span className="ms-1 text-xs font-normal text-text-mute">
                        gross, what the shop paid
                    </span>
                </span>
                <input
                    name="total"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                    className="rounded-md border border-border bg-transparent px-2 py-1.5 text-right tabular-nums"
                />
            </label>
            <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">
                    VAT amount (AED)
                    <span className="ms-1 text-xs font-normal text-text-mute">
                        reclaimable input VAT — 0 if none
                    </span>
                </span>
                <input
                    name="vatAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={vat}
                    onChange={(e) => setVat(e.target.value)}
                    className={`rounded-md border bg-transparent px-2 py-1.5 text-right tabular-nums ${
                        showMismatch
                            ? "border-danger-500/60 text-danger-700"
                            : "border-border"
                    }`}
                />
            </label>
            {/* Derived subtotal — full-width caption spanning the two
                inputs above. Shows the honest breakdown so the
                operator sees what will actually post to the ledger. */}
            <div className="sm:col-span-2">
                {showMismatch ? (
                    <div className="rounded-md border border-danger-500/40 bg-danger-50 px-3 py-2 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
                        VAT amount ({fmt(vatNum)}) can&apos;t be more than the
                        total ({fmt(totalNum)}). Adjust one before recording.
                    </div>
                ) : invariantHolds ? (
                    <div className="rounded-md border border-border bg-surface-2/30 px-3 py-2 text-xs text-text-mute">
                        Net (posts to the expense account):{" "}
                        <span className="tabular-nums font-medium text-text">
                            {fmt(subtotalNum)}
                        </span>
                        {vatNum > 0 ? (
                            <>
                                {" · VAT (posts to VAT Recoverable): "}
                                <span className="tabular-nums font-medium text-text">
                                    {fmt(vatNum)}
                                </span>
                            </>
                        ) : null}
                    </div>
                ) : (
                    <div className="rounded-md border border-border bg-surface-2/30 px-3 py-2 text-xs text-text-mute">
                        Enter an amount to see the net-vs-VAT breakdown.
                    </div>
                )}
            </div>
        </>
    );
}
