"use client";

import { useState } from "react";
import {
    deriveUnitPriceFromCost,
    deriveMarkupFromPrice,
    lineMargin,
} from "@/lib/pricing";

/**
 * Cost-based line inputs — Qty, Cost/unit, Markup %, Unit price
 * (AR 2026-08-12). Two-way bound: editing cost or markup recomputes
 * price live; overriding price recomputes markup live. Whichever
 * value the advisor last saw is what persists — the server picks up
 * `qty`, `unitCost`, `markupPct`, `unitPrice` from the enclosing form
 * on submit and writes them verbatim.
 *
 * Only rendered for PART lines. Labor / fee / discount lines keep
 * the plain Qty + Unit two-input form (they have no cost concept).
 *
 * Margin display — internal-only, never printed. Shows the derived
 * `(unitPrice - unitCost) × qty` in the same row so the advisor sees
 * the profitability of the line as they price it.
 *
 * State model — three independent controlled inputs backed by
 * strings (not numbers) so intermediate keystrokes like `1.` or a
 * leading `.` don't get coerced weirdly. `useState` seeds from the
 * DB row's saved decimals (nulls become blank strings). Every
 * re-derivation runs on change of one input and mutates only the
 * *other* two — so the field the advisor is actively typing in
 * never re-formats under their cursor.
 */
export interface CostPricedInputsProps {
    initial: {
        qty: number;
        unitCost: number | null;
        markupPct: number | null;
        unitPrice: number;
    };
    labels: {
        qty: string;
        cost: string;
        markup: string;
        unit: string;
        margin: string;
    };
}

function fmt(n: number | null): string {
    if (n == null || !Number.isFinite(n)) return "";
    return String(n);
}

function parseOrNull(s: string): number | null {
    const trimmed = s.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
}

const FIELD =
    "h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";

export function CostPricedInputs({ initial, labels }: CostPricedInputsProps) {
    const [qty, setQty] = useState(fmt(initial.qty));
    const [unitCost, setUnitCost] = useState(fmt(initial.unitCost));
    const [markupPct, setMarkupPct] = useState(fmt(initial.markupPct));
    const [unitPrice, setUnitPrice] = useState(fmt(initial.unitPrice));

    // Cost or markup changed → recompute unit price (leave markup alone
    // so the advisor's cursor stays in the field they're typing in).
    function onCostChange(next: string) {
        setUnitCost(next);
        const derived = deriveUnitPriceFromCost({
            unitCost: parseOrNull(next),
            markupPct: parseOrNull(markupPct),
        });
        if (derived != null) setUnitPrice(String(derived));
    }
    function onMarkupChange(next: string) {
        setMarkupPct(next);
        const derived = deriveUnitPriceFromCost({
            unitCost: parseOrNull(unitCost),
            markupPct: parseOrNull(next),
        });
        if (derived != null) setUnitPrice(String(derived));
    }
    // Price override → recompute markup (leave cost alone).
    function onPriceChange(next: string) {
        setUnitPrice(next);
        const derived = deriveMarkupFromPrice({
            unitCost: parseOrNull(unitCost),
            unitPrice: parseOrNull(next),
        });
        if (derived != null) setMarkupPct(String(derived));
    }

    const margin = lineMargin({
        unitCost: parseOrNull(unitCost),
        unitPrice: parseOrNull(unitPrice),
        qty: parseOrNull(qty),
    });

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
                <label className="flex flex-col text-xs text-text-mute">
                    {labels.qty}
                    <input
                        name="qty"
                        type="number"
                        step="any"
                        min="0"
                        inputMode="decimal"
                        value={qty}
                        onChange={(e) => setQty(e.target.value)}
                        className={`${FIELD} mt-1 w-24 text-right`}
                    />
                </label>
                <label className="flex flex-col text-xs text-text-mute">
                    {labels.cost}
                    <input
                        name="unitCost"
                        type="number"
                        step="any"
                        min="0"
                        inputMode="decimal"
                        value={unitCost}
                        onChange={(e) => onCostChange(e.target.value)}
                        className={`${FIELD} mt-1 w-28 text-right`}
                    />
                </label>
                <label className="flex flex-col text-xs text-text-mute">
                    {labels.markup}
                    <input
                        name="markupPct"
                        type="number"
                        step="any"
                        inputMode="decimal"
                        value={markupPct}
                        onChange={(e) => onMarkupChange(e.target.value)}
                        className={`${FIELD} mt-1 w-24 text-right`}
                    />
                </label>
                <label className="flex flex-col text-xs text-text-mute">
                    {labels.unit}
                    <input
                        name="unitPrice"
                        type="number"
                        step="any"
                        min="0"
                        inputMode="decimal"
                        value={unitPrice}
                        onChange={(e) => onPriceChange(e.target.value)}
                        className={`${FIELD} mt-1 w-28 text-right`}
                    />
                </label>
            </div>
            {margin != null ? (
                <div className="text-xs text-text-mute">
                    {labels.margin}:{" "}
                    <span
                        className={
                            "font-semibold tabular-nums " +
                            (margin < 0
                                ? "text-danger-700 dark:text-danger-500"
                                : "text-success-700 dark:text-success-500")
                        }
                    >
                        {margin.toFixed(2)}
                    </span>
                </div>
            ) : null}
        </div>
    );
}
