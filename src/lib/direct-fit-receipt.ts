/**
 * Direct-fit receive — decision helpers (AR 2026-08-16).
 *
 * See docs/direct-fit-receive-spec.md for the two-category model. This
 * module holds the pure decisions the receive form + action need,
 * split out from the Prisma-touching receive action so both can be
 * unit-tested without a DB.
 *
 * The two categories at receive time:
 *
 *   • STOCK    — catalogue part. Quantity into inventory,
 *                Part.cost blended. Existing path unchanged.
 *   • DIRECT   — bought for a specific job, fitted, never enters
 *                stock. No Part row. Cost lands on JobPartReceipt +
 *                (if the estimate hasn't been invoiced) updates the
 *                source EstimateLine.unitCost.
 *
 * Default per AR 2026-08-16: **every unlinked line defaults to
 * DIRECT**. The system cannot infer which items a shop keeps on a
 * shelf, so the safe default is "does not fill the catalogue with
 * duplicates". Owners flip to STOCK deliberately when the line is a
 * consumable they reorder.
 */

export type ReceiveMode = "STOCK" | "DIRECT";
export const DEFAULT_MODE_FOR_UNLINKED: ReceiveMode = "DIRECT";

/**
 * Parse the per-line mode from formData. An unknown / missing value
 * falls back to DIRECT — the safer default (won't accidentally spawn
 * a catalogue row).
 */
export function parseReceiveMode(raw: unknown): ReceiveMode {
    return raw === "STOCK" ? "STOCK" : "DIRECT";
}

/**
 * Should the invoice have already frozen this line's cost? Direct-fit
 * receive updates EstimateLine.unitCost only when the answer is NO
 * (pre-invoice). Post-invoice, the accepted rule is that the invoice
 * snapshot is authoritative — see the spec's "Post-invoice ordering
 * rule" section.
 */
export function shouldUpdateEstimateCost(input: {
    invoiceExists: boolean;
    currentUnitCost: number | null;
    receivedUnitCost: number;
}): boolean {
    if (input.invoiceExists) return false;
    if (input.receivedUnitCost < 0) return false;
    // No prior cost recorded → any received cost is worth capturing.
    if (input.currentUnitCost === null) return true;
    // Identical to the penny → no write, avoids UPDATE churn.
    return round2(input.currentUnitCost) !== round2(input.receivedUnitCost);
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * Normalize a description for the "you stock a part called X" hint.
 * Delegates to the existing catalogue-match normalizer in estimate-to-po
 * so a single algorithm decides "same part?" everywhere.
 *
 * Re-exported here so the receive UI / action can import from one
 * module rather than reaching into estimate-to-po (which is scoped
 * to the from-estimate flow).
 */
export { normalizePartName, findNormalizedMatch } from "./estimate-to-po";
