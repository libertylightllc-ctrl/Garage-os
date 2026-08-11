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

export interface LineProps {
    line: {
        id: string;
        kind: string;
        description: string;
        qty: number;
        // Cost-based pricing (AR 2026-08-12). Both nullable — labor /
        // fee lines have no cost concept; legacy PART rows created
        // before this feature have neither. The editor's tri-input
        // mode only renders for PART lines that were edited under
        // the new UX (or fresh rows); older PART rows fall back to
        // the plain Qty + Unit two-input form so nothing breaks.
        unitCost: number | null;
        markupPct: number | null;
        unitPrice: number;
        lineTotal: number;
        declined: boolean;
    };
    /** Optional locale-translated description override for idle mode. */
    displayDescription?: string;
    /** Vehicle on the job — driven into the Make/Model/Year columns. */
    vehicle: {
        make: string | null;
        model: string | null;
        year: number | null;
    };
    estimateId: string;
    editable: boolean;
    canDecline: boolean;
    /** Total number of columns in the parent table — used by the
     *  editing-mode row's <td colspan> so the inline form spans the
     *  full width without breaking the column grid. */
    columnCount: number;
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
        // Cost-based inputs (PART lines only)
        qty: string;
        cost: string;
        markup: string;
        unit: string;
        margin: string;
    };
}

const FIELD =
    "h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";
const ACTION =
    "inline-flex h-8 items-center justify-center rounded-lg px-2 text-xs font-semibold hover:bg-surface-2 transition-colors";

/**
 * One table ROW per estimate line. Modes:
 *   idle    — Kind | Part | Make | Model | Year | Qty | Unit | Total | Actions cells
 *   editing — single full-width <td colspan> with the inline form
 *
 * Vehicle make / model / year render in their own columns. The
 * description column is auto-stripped of any legacy "(MAKE MODEL)"
 * suffix so old snapshots still read cleanly without the redundant
 * info — see stripVehicleLabel. PART kind is the only one that fills
 * Make / Model / Year cells; LABOR / FEE / DISCOUNT lines leave them
 * blank since they aren't vehicle-specific.
 */
export function EstimateLineRow({
    line,
    displayDescription,
    vehicle,
    estimateId,
    editable,
    canDecline,
    columnCount,
    labels,
}: LineProps) {
    const [editing, setEditing] = useState(false);

    const isDiscountLine = line.kind === "FEE" && line.unitPrice < 0;
    const displayKind = isDiscountLine ? "DISCOUNT" : line.kind;
    const priceForInput =
        line.unitPrice === 0 ? "" : String(Math.abs(line.unitPrice));

    // Display description gets the locale-translated copy when provided,
    // then strips any embedded "(Make Model)" suffix from legacy snapshots
    // so the column reads "Oil filter" cleanly with Make / Model in their
    // own cells. Strip is a no-op when the suffix isn't there.
    const cleanDescription = stripVehicleLabel(
        displayDescription ?? line.description,
        vehicle.make,
        vehicle.model,
    );
    // The edit form's defaultValue must round-trip the canonical stored
    // description (not the translated / stripped copy) so a save keeps
    // exactly what's in the DB.
    const editDefault = stripVehicleLabel(line.description, vehicle.make, vehicle.model);

    const isPart = line.kind === "PART";
    const valueClass = line.declined
        ? "line-through text-text-mute"
        : "";
    // Compact one-liner for the desktop "Vehicle" column. PART lines
    // get make/model/year glued together; non-vehicle lines (labor,
    // fee, discount) show an em-dash so the column reads consistently.
    const vehicleLabel = isPart
        ? [vehicle.make, vehicle.model, vehicle.year]
            .filter(Boolean)
            .join(" ") || "—"
        : "—";

    // ---- Editing mode ----
    if (editing && editable) {
        return (
            <tr className="border-b border-border bg-surface-2">
                <td colSpan={columnCount} className="p-3">
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
                            /* Cost-based tri-input for PART lines (AR 2026-08-12).
                               Two-way binds cost ↔ markup ↔ price. Kind swap in
                               the edit dropdown → server-side, the parseLineEditInput
                               treats unitCost/markupPct as optional; if the advisor
                               flipped the row from PART → LABOR mid-edit, cost + markup
                               are ignored. */
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
                </td>
            </tr>
        );
    }

    // ---- Idle mode: real table row ----
    const td = "px-2 py-2 align-top text-sm";
    return (
        <tr className={`border-b border-border ${line.declined ? "opacity-60" : ""}`}>
            <td className={td}>
                <span className="inline-block rounded bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-mute">
                    {displayKind}
                </span>
            </td>
            <td className={`${td} whitespace-nowrap ${valueClass}`}>{vehicleLabel}</td>
            <td className={`${td} font-medium ${valueClass}`}>{cleanDescription}</td>
            <td className={`${td} text-right tabular-nums ${valueClass}`}>{Number(line.qty)}</td>
            <td className={`${td} text-right tabular-nums ${valueClass}`}>
                {Number(line.unitPrice).toFixed(2)}
            </td>
            <td className={`${td} text-right font-semibold tabular-nums ${valueClass}`}>
                {Number(line.lineTotal).toFixed(2)}
            </td>
            {editable || canDecline ? (
                <td className={`${td} whitespace-nowrap`}>
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
                </td>
            ) : null}
        </tr>
    );
}
