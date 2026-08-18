"use client";

import { useState } from "react";
import {
    removeEstimateLineAction,
    toggleEstimateLineAction,
    updateEstimateLineAction,
} from "@/app/actions/billing";
import { ConfirmButton } from "@/components/confirm-button";
import { stripVehicleLabel } from "@/lib/jobcard-fields";
import { CostPricedInputs } from "@/components/cost-priced-inputs";

export interface CardProps {
    line: {
        id: string;
        kind: string;
        description: string;
        qty: number;
        // Cost-based pricing (AR 2026-08-12); see estimate-line-row.tsx
        // for the shape rationale.
        unitCost: number | null;
        markupPct: number | null;
        unitPrice: number;
        lineTotal: number;
        declined: boolean;
    };
    displayDescription?: string;
    vehicle: {
        make: string | null;
        model: string | null;
        year: number | null;
    };
    estimateId: string;
    editable: boolean;
    canDecline: boolean;
    /**
     * Whether the current viewer is allowed to see cost + markup +
     * margin. False for cashier + tech; true for advisor + owner +
     * master. When false, PART lines render the plain qty + unit
     * price form (same shape as LABOR / FEE) — no cost, markup, or
     * margin cell — AND the server-side prop map has already nulled
     * out `line.unitCost` and `line.markupPct` so the RSC payload
     * itself carries no cost number. Belt-and-braces (AR 2026-08-14).
     */
    canShowCost: boolean;
    labels: {
        edit: string;
        delete: string;
        save: string;
        cancel: string;
        skip: string;
        restore: string;
        confirmDelete: string;
        kindLabor: string;
        kindPart: string;
        kindFee: string;
        kindDiscount: string;
        // Cost-based inputs (PART lines)
        qty: string;
        cost: string;
        markup: string;
        unit: string;
        margin: string;
        // Pre-flight "No price" chip (AR 2026-08-18) — mirror of the
        // desktop row component.
        noPriceChip: string;
        noPriceChipTitle: string;
    };
}

const FIELD =
    "h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";
const ACTION =
    "inline-flex h-9 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold hover:bg-surface-2 transition-colors";

/**
 * Mobile card view of one estimate line. Same data + actions as the
 * sibling EstimateLineRow but reflows everything into a vertically
 * stacked card so phones don't have to horizontally scroll a 9-column
 * table.
 *
 *   ┌───────────────────────────────────────────┐
 *   │ [PART]                  [Edit][Skip][Del] │
 *   │ Ford Focus 2014                           │
 *   │ Oil filter                                │
 *   │ Qty 1   ·   Unit AED 234.00   ·   ...     │
 *   │                          Total AED 234.00 │
 *   └───────────────────────────────────────────┘
 *
 * Edit mode reuses the same kind / description / qty / unitPrice
 * fields as the desktop table — single form, no field divergence
 * between layouts.
 *
 * Both the card and the table render the same data; the page hides one
 * with a `md:` breakpoint. Keeping them as separate components keeps
 * each layout simple and avoids `tr` / `div` mode-juggling in one file.
 */
export function EstimateLineCard({
    line,
    displayDescription,
    vehicle,
    estimateId,
    editable,
    canDecline,
    canShowCost,
    labels,
}: CardProps) {
    const [editing, setEditing] = useState(false);

    const isDiscountLine = line.kind === "FEE" && line.unitPrice < 0;
    const displayKind = isDiscountLine ? "DISCOUNT" : line.kind;
    const priceForInput =
        line.unitPrice === 0 ? "" : String(Math.abs(line.unitPrice));

    const cleanDescription = stripVehicleLabel(
        displayDescription ?? line.description,
        vehicle.make,
        vehicle.model,
    );
    const editDefault = stripVehicleLabel(line.description, vehicle.make, vehicle.model);

    // isPart drives the cost/markup/margin tri-input branch. A PART
    // line viewed by cashier / tech (canShowCost === false) routes to
    // the plain qty + unit form instead, so no cost cell renders and
    // no cost value reaches the DOM.
    const isPart = line.kind === "PART" && canShowCost;
    const valueClass = line.declined ? "line-through text-text-mute" : "";

    // Compact one-line vehicle label for the card header. Hide entirely
    // on non-vehicle lines (labor/fee/discount) so the row reads "PART
    // — Ford Focus 2014" vs "LABOR — (nothing extra)" without an empty
    // "—" placeholder eating a row.
    const vehicleLabel = isPart
        ? [vehicle.make, vehicle.model, vehicle.year]
            .filter(Boolean)
            .join(" ")
        : "";

    // ── Editing mode — same form as the table row, stacked. ──
    if (editing && editable) {
        return (
            <div className="rounded-xl border border-border bg-surface-2 p-3">
                <form
                    action={updateEstimateLineAction}
                    className="flex flex-col gap-3"
                    onSubmit={() => setEditing(false)}
                >
                    <input type="hidden" name="estimateId" value={estimateId} />
                    <input type="hidden" name="lineId" value={line.id} />
                    <div className="flex flex-wrap gap-2">
                        <select name="kind" defaultValue={displayKind} className={`${FIELD} w-32`}>
                            <option value="LABOR">{labels.kindLabor}</option>
                            <option value="PART">{labels.kindPart}</option>
                            <option value="FEE">{labels.kindFee}</option>
                            <option value="DISCOUNT">{labels.kindDiscount}</option>
                        </select>
                        <input
                            name="description"
                            defaultValue={editDefault}
                            required
                            className={`${FIELD} min-w-40 flex-1`}
                        />
                    </div>
                    {isPart ? (
                        <CostPricedInputs
                            initial={{
                                qty: line.qty,
                                unitCost: line.unitCost,
                                markupPct: line.markupPct,
                                unitPrice: Math.abs(line.unitPrice),
                            }}
                            labels={{
                                qty: labels.qty,
                                cost: labels.cost,
                                markup: labels.markup,
                                unit: labels.unit,
                                margin: labels.margin,
                            }}
                        />
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            <label className="flex flex-col text-xs text-text-mute">
                                {labels.qty}
                                <input
                                    name="qty"
                                    type="number"
                                    step="any"
                                    min="0"
                                    inputMode="decimal"
                                    defaultValue={line.qty}
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
                                    defaultValue={priceForInput}
                                    className={`${FIELD} mt-1 flex-1 text-right`}
                                />
                            </label>
                        </div>
                    )}
                    <div className="flex gap-2">
                        <button
                            type="submit"
                            className="inline-flex h-10 flex-1 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
                        >
                            {labels.save}
                        </button>
                        <button
                            type="button"
                            onClick={() => setEditing(false)}
                            className="inline-flex h-10 flex-1 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors"
                        >
                            {labels.cancel}
                        </button>
                    </div>
                </form>
            </div>
        );
    }

    // ── Idle mode — vertically stacked card. ──
    return (
        <div
            className={`flex flex-col gap-2 rounded-xl border border-border p-3 ${line.declined ? "opacity-60" : ""}`}
        >
            {/* Row 1: kind badge + action buttons */}
            <div className="flex items-center justify-between gap-2">
                <span className="inline-block rounded bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-mute">
                    {displayKind}
                </span>
                {editable || canDecline ? (
                    <div className="flex flex-wrap items-center gap-1">
                        {editable ? (
                            <button type="button" onClick={() => setEditing(true)} className={ACTION}>
                                {labels.edit}
                            </button>
                        ) : null}
                        {canDecline ? (
                            <form action={toggleEstimateLineAction}>
                                <input type="hidden" name="estimateId" value={estimateId} />
                                <input type="hidden" name="lineId" value={line.id} />
                                <button className={ACTION}>
                                    {line.declined ? labels.restore : labels.skip}
                                </button>
                            </form>
                        ) : null}
                        {editable ? (
                            <form action={removeEstimateLineAction}>
                                <input type="hidden" name="estimateId" value={estimateId} />
                                <input type="hidden" name="lineId" value={line.id} />
                                <ConfirmButton
                                    message={labels.confirmDelete}
                                    className={`${ACTION} text-danger-700 hover:bg-danger-50 dark:text-danger-500 dark:hover:bg-danger-500/10`}
                                >
                                    {labels.delete}
                                </ConfirmButton>
                            </form>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {/* Row 2: vehicle one-liner — only on PART lines */}
            {vehicleLabel ? (
                <p className={`text-xs text-text-mute ${valueClass}`}>🚗 {vehicleLabel}</p>
            ) : null}

            {/* Row 3: part / description name (+ pre-flight chip). */}
            <p className={`text-base font-semibold ${valueClass}`}>
              {cleanDescription}
              {line.kind === "PART" && !line.declined && Number(line.unitPrice) === 0 ? (
                <span
                  className="ms-2 inline-flex items-center rounded-full border border-warning-500/40 bg-warning-50 px-2 py-0.5 text-[10px] font-semibold text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500"
                  title={labels.noPriceChipTitle}
                >
                  {labels.noPriceChip}
                </span>
              ) : null}
            </p>

            {/* Row 4: qty + unit + total mini-grid. Labels above, numbers
                right-aligned and tabular so e.g. 234.00 and 1,890.00 line
                up cleanly. Total emphasized as the at-a-glance value the
                cashier's eye lands on. */}
            <dl className="mt-1 grid grid-cols-3 gap-2 border-t border-border pt-2 text-xs">
                <div className="flex flex-col">
                    <dt className="text-text-mute">Qty</dt>
                    <dd className={`text-sm tabular-nums ${valueClass}`}>{Number(line.qty)}</dd>
                </div>
                <div className="flex flex-col">
                    <dt className="text-text-mute">Unit</dt>
                    <dd className={`text-sm tabular-nums ${valueClass}`}>
                        {Number(line.unitPrice).toFixed(2)}
                    </dd>
                </div>
                <div className="flex flex-col items-end">
                    <dt className="text-text-mute">Total</dt>
                    <dd className={`text-base font-semibold tabular-nums ${valueClass}`}>
                        AED {Number(line.lineTotal).toFixed(2)}
                    </dd>
                </div>
            </dl>
        </div>
    );
}
