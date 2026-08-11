/**
 * Cost-based pricing helpers for the advisor's estimate line editor
 * (AR 2026-08-12). Pure — no I/O, no Prisma. All money is normal
 * `number` here because these run in the browser as part of a Client
 * Component (see src/components/cost-priced-inputs.tsx) — the server
 * still parses via Number(...) and persists as Prisma Decimal, so the
 * float representation lives only during user interaction.
 *
 * Two derivations, in both directions:
 *
 *   deriveUnitPriceFromCost({unitCost, markupPct})
 *     = round(unitCost × (1 + markupPct/100), 2)
 *
 *   deriveMarkupFromPrice({unitCost, unitPrice})
 *     = round((unitPrice / unitCost - 1) × 100, 2)
 *
 * The editor UX is:
 *   - Advisor types cost or markup → we recompute unitPrice, show it.
 *   - Advisor overrides unitPrice → we recompute markupPct, show it.
 * The last value they SAW is what persists (rounded).
 *
 * All three helpers return `null` when their inputs are incomplete
 * (missing / non-numeric / non-positive cost), rather than throwing —
 * live keystroke handlers need a soft "no answer yet" state, not an
 * exception on every intermediate input.
 */

export interface CostBasedInputs {
    unitCost: number | null;
    markupPct: number | null;
    unitPrice: number | null;
}

function roundTo2(n: number): number {
    // "Banker's" rounding is overkill for retail money in AED — the
    // ledger tolerates ±0.005 rounding on line-by-line derivations
    // because the invoice total is what the customer pays. Half-up
    // (Math.round after ×100) is fine and matches what the invoice
    // template renders with .toFixed(2).
    return Math.round(n * 100) / 100;
}

/**
 * Given cost + markup %, return the derived selling price.
 * Returns null when either input is missing / non-positive.
 * unitCost === 0 → treated as "give it away": returns 0 (regardless of markup).
 */
export function deriveUnitPriceFromCost(input: {
    unitCost: number | null;
    markupPct: number | null;
}): number | null {
    const c = input.unitCost;
    const m = input.markupPct;
    if (c == null || !Number.isFinite(c) || c < 0) return null;
    if (m == null || !Number.isFinite(m)) return null;
    if (c === 0) return 0;
    return roundTo2(c * (1 + m / 100));
}

/**
 * Given cost + selling price, return the implied markup %.
 * Returns null when cost is missing / zero / non-positive (division
 * would blow up or the answer is meaningless). Price can be zero →
 * that's a 100% loss (markup = -100%), which the caller may want to
 * flag but is a valid answer.
 */
export function deriveMarkupFromPrice(input: {
    unitCost: number | null;
    unitPrice: number | null;
}): number | null {
    const c = input.unitCost;
    const p = input.unitPrice;
    if (c == null || !Number.isFinite(c) || c <= 0) return null;
    if (p == null || !Number.isFinite(p)) return null;
    return roundTo2((p / c - 1) * 100);
}

/**
 * Line-level margin = (unitPrice - unitCost) × qty, rounded to 2 dp.
 * Returns null when any input is missing. Displayed on the advisor's
 * line editor (internal — never on customer surfaces).
 */
export function lineMargin(input: {
    unitCost: number | null;
    unitPrice: number | null;
    qty: number | null;
}): number | null {
    const { unitCost, unitPrice, qty } = input;
    if (unitCost == null || !Number.isFinite(unitCost)) return null;
    if (unitPrice == null || !Number.isFinite(unitPrice)) return null;
    if (qty == null || !Number.isFinite(qty) || qty < 0) return null;
    return roundTo2((unitPrice - unitCost) * qty);
}
