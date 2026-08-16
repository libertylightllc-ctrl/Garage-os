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

/**
 * Decide whether a JobPartReceipt's cost is provably reflected on the
 * invoice snapshot (AR 2026-08-16). Called by the job-profit loader
 * to decide `receiptsUnreconciled` on the coverage record.
 *
 * Rule — all three must hold:
 *   1. Receipt has a sourceEstimateLine (the from-estimate path).
 *      Manual PO path receipts have no source line to reconcile
 *      against, so they never count as reconciled — the operator is
 *      responsible for capturing the cost separately if they want
 *      it on the invoice.
 *   2. The source EstimateLine.unitCost equals the receipt's
 *      receivedUnitCost to 2dp. This is the writeback signature —
 *      shouldUpdateEstimateCost updated the estimate line to the
 *      received value at receive time. If the advisor later re-edited
 *      the estimate to a different cost, the invoice snapshot no
 *      longer matches the receipt, so we can't claim reconciliation.
 *   3. The source estimate has an invoice — the writeback made it
 *      into a frozen snapshot.
 *
 * Any receipt failing all three is unreconciled. Rule is deliberately
 * strict: over-claiming a receipt as reconciled would understate
 * parts cost by an unknown amount, exactly the failure mode AR
 * pointed at.
 */
export interface ReconcilableReceipt {
    receivedUnitCost: number;
    /**
     * The source estimate line's snapshot at read time. null when the
     * PO line was added manually (no sourceEstimateLineId).
     */
    sourceEstimateLine: {
        unitCost: number | null;
        estimateHasInvoice: boolean;
    } | null;
}

export function isReceiptReconciledOnInvoice(
    r: ReconcilableReceipt,
): boolean {
    if (!r.sourceEstimateLine) return false;
    if (!r.sourceEstimateLine.estimateHasInvoice) return false;
    if (r.sourceEstimateLine.unitCost === null) return false;
    return (
        round2(r.sourceEstimateLine.unitCost) ===
        round2(r.receivedUnitCost)
    );
}
