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
    /** Raw stored description (what the cashier typed). Used as the
     *  edit-form defaultValue so saves round-trip without mutating
     *  what's stored. */
    description: string;
    qty: number;
    unitPrice: number;
    lineTotal: number;
    declined: boolean;
  };
  /** Optional display-only override for the description shown in
   *  idle mode. Parents pass the locale-translated version here so
   *  Arabic-locale renders see Arabic, while the edit form still
   *  loads the canonical English (or whatever was typed) for editing. */
  displayDescription?: string;
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
// Padding gives 40px tap height — matches the Workshop md button size.
const FIELD =
  "h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";
const ACTION =
  "inline-flex h-10 items-center justify-center rounded-lg px-3 text-sm font-semibold hover:bg-surface-2 transition-colors";

/**
 * One CARD per estimate line. Two modes:
 *
 *   idle    — read-only display + [Edit] [Skip/Restore] [Delete] buttons
 *   editing — inline form (kind dropdown + description + qty + unit price)
 *             + [Save] [Cancel] buttons. Cancel discards local edits, no
 *             server round-trip.
 *
 * We render as a <div> card (not a <tr>) so each line gets its own breathing
 * room on narrow screens. The previous table layout collapsed numbers
 * together on mobile ("185.511.00185.51") — cards fix that by giving the
 * numbers labels and their own line.
 *
 * The kind dropdown shows DISCOUNT separately even though it stores as
 * FEE with a negative amount — matches addEstimateLineAction's sugar.
 * On render, a FEE line with negative price is detected and the dropdown
 * pre-selects DISCOUNT so the round-trip preserves intent.
 */
export function EstimateLineRow({
  line,
  displayDescription,
  estimateId,
  editable,
  canDecline,
  labels,
}: LineProps) {
  const [editing, setEditing] = useState(false);

  // Display kind: surface DISCOUNT for negative FEE lines so the user
  // sees the same word they typed when they added the line.
  const isDiscountLine = line.kind === "FEE" && line.unitPrice < 0;
  const displayKind = isDiscountLine ? "DISCOUNT" : line.kind;
  const priceForInput = Math.abs(line.unitPrice).toFixed(2);

  // ---- Editing mode: full inline edit form ----
  if (editing && editable) {
    return (
      <div className="rounded-xl border border-border bg-surface-2 p-4">
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
              defaultValue={line.description}
              required
              className={`${FIELD} min-w-40 flex-1`}
            />
          </div>
          {/* step="any" — let the user type any decimal (35, 35.5, 35.00).
              Server still enforces qty > 0 and price >= 0, so the UI step
              is purely a hint. */}
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">
              Qty
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
            <label className="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">
              Unit (AED)
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
          <div className="flex gap-2">
            <button
              type="submit"
              className="inline-flex h-10 flex-1 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            >
              {labels.save}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex h-10 flex-1 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            >
              {labels.cancel}
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ---- Idle mode: card display ----
  const cardClass =
    "rounded-lg border border-black/10 bg-white p-3 dark:border-white/15 dark:bg-zinc-950 " +
    (line.declined ? "opacity-60" : "");
  const valueClass = line.declined ? "line-through" : "";

  return (
    <div className={cardClass}>
      {/* Row 1: kind badge + description */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <span className="inline-block rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {displayKind}
          </span>
          <p className={`mt-1.5 text-base font-medium ${valueClass}`}>
            {displayDescription ?? line.description}
          </p>
        </div>
        {/* Big line total on the right — the cashier's eye lands here */}
        <div className="text-right">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">Total</div>
          <div className={`text-lg font-semibold tabular-nums ${valueClass}`}>
            AED {Number(line.lineTotal).toFixed(2)}
          </div>
        </div>
      </div>

      {/* Row 2: qty × unit price breakdown */}
      <div className="mt-2 flex items-center gap-1 text-sm text-zinc-600 dark:text-zinc-300">
        <span className="tabular-nums">{Number(line.qty)}</span>
        <span className="text-zinc-400">×</span>
        <span className="tabular-nums">AED {Number(line.unitPrice).toFixed(2)}</span>
      </div>

      {/* Row 3: actions */}
      {editable || canDecline ? (
        <div className="mt-3 flex flex-wrap gap-1 border-t border-black/5 pt-2 dark:border-white/10">
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
            <form action={removeEstimateLineAction} className="ms-auto">
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
      ) : null}
    </div>
  );
}
