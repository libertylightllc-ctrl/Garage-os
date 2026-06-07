"use client";

import { useState } from "react";
import {
  removeEstimateLineAction,
  toggleEstimateLineAction,
  updateEstimateLineAction,
} from "@/app/actions/billing";
import { ConfirmButton } from "@/components/confirm-button";

export interface LineProps {
  line: {
    id: string;
    kind: string;
    description: string;
    qty: number;
    unitPrice: number;
    lineTotal: number;
    declined: boolean;
  };
  estimateId: string;
  /** DRAFT + pricing role → Edit + Delete are visible. */
  editable: boolean;
  /** !invoice + pricing role → Skip/Restore is visible (separate from delete). */
  canDecline: boolean;
  labels: {
    edit: string;
    delete: string;
    save: string;
    cancel: string;
    skip: string;
    restore: string;
    confirmDelete: string;
    /** Header labels for the kind dropdown */
    kindLabor: string;
    kindPart: string;
    kindFee: string;
    kindDiscount: string;
  };
}

// 16px (text-base) on inputs prevents iOS Safari from auto-zooming on focus.
// Padding gives ~44px tap height — meets iOS HIG / Android Material minimums.
const FIELD =
  "rounded-md border border-black/15 bg-transparent px-3 py-2 text-base dark:border-white/20";
// Action "links" (Edit / Delete / Skip) are real tap targets — sized like
// buttons, not the text-xs underlined links they were before.
const ACTION =
  "rounded-md px-3 py-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/10";

/**
 * One <tr> per estimate line. Two modes:
 *
 *   idle    — read-only display + [Edit] [Delete] [Skip/Restore] buttons
 *   editing — inline form (kind dropdown + description + qty + unit price)
 *             + [Save] [Cancel] buttons. Cancel discards local edits, no
 *             server round-trip.
 *
 * The kind dropdown shows DISCOUNT separately even though it stores as
 * FEE with a negative amount — matches addEstimateLineAction's sugar.
 * On render, a FEE line with negative price is detected and the dropdown
 * pre-selects DISCOUNT so the round-trip preserves intent.
 */
export function EstimateLineRow({ line, estimateId, editable, canDecline, labels }: LineProps) {
  const [editing, setEditing] = useState(false);

  // Display kind: surface DISCOUNT for negative FEE lines so the user
  // sees the same word they typed when they added the line.
  const isDiscountLine = line.kind === "FEE" && line.unitPrice < 0;
  const displayKind = isDiscountLine ? "DISCOUNT" : line.kind;
  const priceForInput = Math.abs(line.unitPrice).toFixed(2);

  const rowClass =
    "border-b border-black/5 dark:border-white/10 " +
    (line.declined && !editing ? "text-zinc-400 line-through" : "");

  // ---- Editing mode: full inline edit form ----
  if (editing && editable) {
    return (
      <tr className="border-b border-black/5 dark:border-white/10">
        <td colSpan={5} className="py-3">
          <form
            action={updateEstimateLineAction}
            className="flex flex-wrap items-center gap-2"
            onSubmit={() => setEditing(false)}
          >
            <input type="hidden" name="estimateId" value={estimateId} />
            <input type="hidden" name="lineId" value={line.id} />
            <select name="kind" defaultValue={displayKind} className={`${FIELD} w-32`}>
              <option value="LABOR">{labels.kindLabor}</option>
              <option value="PART">{labels.kindPart}</option>
              <option value="FEE">{labels.kindFee}</option>
              <option value="DISCOUNT">{labels.kindDiscount}</option>
            </select>
            <input
              name="description"
              defaultValue={line.description}
              required
              className={`${FIELD} min-w-48 flex-1`}
            />
            <input
              name="qty"
              type="number"
              step="0.5"
              min="0.01"
              defaultValue={line.qty}
              className={`${FIELD} w-20 text-right`}
            />
            <input
              name="unitPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={priceForInput}
              className={`${FIELD} w-28 text-right`}
            />
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-base font-semibold text-white dark:bg-white dark:text-black"
            >
              {labels.save}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md border border-black/15 px-4 py-2 text-base font-medium dark:border-white/20"
            >
              {labels.cancel}
            </button>
          </form>
        </td>
      </tr>
    );
  }

  // ---- Idle mode: read-only display + actions ----
  return (
    <tr className={rowClass}>
      <td className="py-3 pr-2 text-base">
        <span className="text-xs uppercase tracking-wide text-zinc-400">{displayKind}</span>{" "}
        {line.description}
      </td>
      <td className="py-3 text-right text-base tabular-nums">{Number(line.qty)}</td>
      <td className="py-3 text-right text-base tabular-nums">
        {Number(line.unitPrice).toFixed(2)}
      </td>
      <td className="py-3 text-right text-base font-medium tabular-nums">
        {Number(line.lineTotal).toFixed(2)}
      </td>
      {editable || canDecline ? (
        <td className="py-3 pl-2 text-right no-underline">
          <div className="flex flex-wrap justify-end gap-1">
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
                  className={`${ACTION} text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40`}
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
