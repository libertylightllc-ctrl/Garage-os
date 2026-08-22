"use client";

/**
 * PriceThisPartRow — one row per technician-required JobPart on
 * the estimate detail page. AR 2026-08-19.
 *
 * Three visual states:
 *   1. Priced (JobPart.estimateLineId set) — no button. Row shows
 *      the resulting line's amount so the advisor sees the work is
 *      done without hunting through the line table.
 *   2. Unpriced + not editable — plain read-only row (matches the
 *      old server-fragment shape).
 *   3. Unpriced + editable — "Price this part" button. Click →
 *      row expands into an inline form (qty + unit cost + unit
 *      price) that submits addLineFromPartAction. Cancel collapses.
 *
 * Prefill discipline (rule 5 — blank ≠ zero): fields start empty
 * even for catalogue-linked JobParts. The catalogue price is a hint,
 * not a default — advisor types the real numbers for THIS job. The
 * old shape (`Number(part.price) : 0`) was exactly how issue #19's
 * silent zeros got created; blank + `required` + parseMoney is the
 * only safe shape.
 */

import { useState } from "react";
import { addLineFromPartAction } from "@/app/actions/billing";
import { CostPricedInputs } from "@/components/cost-priced-inputs";

export interface PriceThisPartRowProps {
  jobPart: {
    id: string;
    partNo: string | null;
    description: string;
    qty: number;
    // Non-null once addLineFromPartAction has priced this JobPart.
    // Cleared automatically when the resulting EstimateLine is
    // deleted (ON DELETE SET NULL on JobPart.estimateLineId).
    estimateLineId: string | null;
  };
  /** The priced amount (unit price × qty) when linked. Null for
   *  unpriced JobParts. Parent looks it up from est.lines by
   *  jobPart.estimateLineId. */
  pricedAmount: number | null;
  estimateId: string;
  editable: boolean;
  currency: string;
  /**
   * Garage default parts markup %, if the shop has set one on
   * settings. Prefilled into the Markup field when the form opens
   * so pricing by markup is one edit (type cost), not two (type
   * cost + type markup). Null when the shop has no default — the
   * Markup field opens blank in that case.
   */
  defaultMarkupPct: number | null;
  labels: {
    priceThisPart: string;
    priced: string;
    qty: string;
    unitCost: string;
    /** e.g. "Markup %" — the tri-input's Markup label. */
    markup: string;
    unitPrice: string;
    /** e.g. "Margin" — line-total profit display under the inputs. */
    margin: string;
    /**
     * e.g. "from garage default" — hint under the Markup field when
     * the prefilled value came from Garage.defaultPartsMarkupPct and
     * the advisor hasn't changed it.
     */
    markupFromDefault: string;
    save: string;
    cancel: string;
  };
}

const BTN_PRIMARY =
  "inline-flex h-10 items-center justify-center rounded-lg bg-brand-900 px-4 text-sm font-semibold text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";
const BTN_SECONDARY =
  "inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-medium text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";
const BTN_OPEN =
  "shrink-0 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2";

export function PriceThisPartRow({
  jobPart,
  pricedAmount,
  estimateId,
  editable,
  currency,
  defaultMarkupPct,
  labels,
}: PriceThisPartRowProps) {
  const [expanded, setExpanded] = useState(false);

  const label = `${jobPart.partNo ? `${jobPart.partNo} ` : ""}${jobPart.description} ×${jobPart.qty}`;

  // State 1 — already priced. Show the amount, no button. Even
  // when editable=true, we hide the button: the JobPart is
  // done. Re-pricing means deleting the line first (which clears
  // the FK and puts this row back into state 3).
  if (jobPart.estimateLineId !== null) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 text-base text-text-mute">
        <span>• {label}</span>
        {pricedAmount !== null ? (
          <span className="shrink-0 text-sm font-medium text-success-700 dark:text-success-500">
            {labels.priced}: {currency} {pricedAmount.toFixed(2)}
          </span>
        ) : null}
      </li>
    );
  }

  // State 2 — unpriced, not editable. Read-only row.
  if (!editable) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 text-base text-text-mute">
        <span>• {label}</span>
      </li>
    );
  }

  // State 3 — unpriced, editable, collapsed. Button opens the form.
  if (!expanded) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 text-base text-text-mute">
        <span>• {label}</span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={BTN_OPEN}
        >
          {labels.priceThisPart}
        </button>
      </li>
    );
  }

  // State 3 (expanded) — inline form. Delegates the tri-input
  // pricing block to CostPricedInputs so the two-way binding
  // (cost×markup → price, price override → markup) is the SAME
  // implementation as the main estimate line editor. The
  // previous shape was a divergent 3-input form that quietly
  // missed the Markup % field for months — see AR 2026-08-22
  // JC-cmt4q2hpy. Reusing the shared component removes the
  // divergence class.
  //
  // Prefill discipline:
  //   qty        → the tech's requested qty (advisor can adjust)
  //   unitCost   → blank (rule 5: blank ≠ zero — advisor types
  //                the real cost for THIS job)
  //   markupPct  → garage's defaultPartsMarkupPct if set, else
  //                blank. When prefilled, CostPricedInputs shows a
  //                small "from default" hint under the field until
  //                the advisor changes the value.
  //   unitPrice  → blank; derives when advisor types cost (given
  //                markup is prefilled). Advisor can also type a
  //                price directly and the markup recomputes.
  //
  // Server: addLineFromPartAction reads unitCost + unitPrice from
  // the form and re-derives markupPct from the ratio (see
  // src/app/actions/billing.ts). Posting a markupPct field is
  // harmless — the server ignores it and re-derives. No server
  // change was needed for this batch.
  return (
    <li className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="mb-2 text-base font-medium">• {label}</div>
      <form action={addLineFromPartAction} className="flex flex-col gap-2">
        <input type="hidden" name="estimateId" value={estimateId} />
        <input type="hidden" name="jobPartId" value={jobPart.id} />
        <CostPricedInputs
          initial={{
            qty: jobPart.qty,
            unitCost: null,
            markupPct: defaultMarkupPct,
            unitPrice: null,
          }}
          labels={{
            qty: labels.qty,
            cost: labels.unitCost,
            markup: labels.markup,
            unit: labels.unitPrice,
            margin: labels.margin,
            markupFromDefault: labels.markupFromDefault,
          }}
          markupFromDefault={defaultMarkupPct != null}
        />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={BTN_PRIMARY}>
            {labels.save}
          </button>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className={BTN_SECONDARY}
          >
            {labels.cancel}
          </button>
        </div>
      </form>
    </li>
  );
}
