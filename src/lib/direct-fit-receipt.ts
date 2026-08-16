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
 * Compare a JobPartReceipt against the invoice snapshot (AR 2026-08-16;
 * rewritten AR 2026-08-16 after INV-2026-0048 review).
 *
 * Earlier version returned a single boolean and the profit card used it
 * to SUPPRESS parts margin whenever any receipt failed to reconcile —
 * too aggressive. If the invoice has cost data on every line, margin
 * IS calculable from what's on the invoice; a mismatched receipt just
 * means the invoiced cost may be stale, which is a warning, not a
 * suppressor. AR's rule: "we don't know" justifies a dash; "we know,
 * but a later receipt says something different" is a number plus a
 * caveat.
 *
 * Three outcomes per receipt:
 *
 *   • "reconciled" — receipt has a source estimate line, that line's
 *     current unitCost matches the receipt's receivedUnitCost to 2dp,
 *     and the estimate has an invoice. The invoiced cost IS the paid
 *     cost. Nothing to warn about.
 *   • "mismatch"   — receipt has a source estimate line with a
 *     comparable unitCost + an invoice, but the numbers disagree.
 *     We can compute a per-unit delta and a total (delta × qty).
 *     The invoice cost is what fed the margin; the delta tells the
 *     owner by how much the invoice may be understating (positive
 *     delta = shop paid more) or overstating (negative) parts cost.
 *   • "unlinkable" — receipt is a direct-fit against a manually-
 *     added PO line (no source), OR the source line has no unitCost
 *     to compare against, OR the source estimate has no invoice yet.
 *     We know the receipt exists but can't check it against the
 *     invoice. The profit card renders a lighter "not linked to an
 *     invoice line — verify the invoiced cost matches" note.
 *
 * The caller passes each receipt's status + delta to
 * computeJobProfit; the compute layer sums the deltas across
 * mismatched receipts and reports counts + total. Parts margin is
 * NEVER suppressed based on receipt status — only on missing
 * InvoiceLine.unitCost. See src/lib/job-profit.ts.
 */
export type ReceiptStatus = "reconciled" | "mismatch" | "unlinkable";

export interface ReconcilableReceipt {
    receivedUnitCost: number;
    /** Line quantity. Used to expand per-unit delta to a total. */
    qty: number;
    /**
     * The source estimate line's snapshot at read time. null when the
     * PO line was added manually (no sourceEstimateLineId).
     */
    sourceEstimateLine: {
        unitCost: number | null;
        estimateHasInvoice: boolean;
    } | null;
}

export interface ReceiptComparison {
    status: ReceiptStatus;
    /**
     * Signed total delta = (receivedUnitCost - invoicedUnitCost) × qty.
     * Positive when the shop paid more than the invoice reflects;
     * negative when it paid less. null for "reconciled" (zero) and
     * "unlinkable" (can't compute).
     */
    totalDelta: number | null;
}

export function compareReceiptToInvoice(
    r: ReconcilableReceipt,
): ReceiptComparison {
    if (
        !r.sourceEstimateLine ||
        !r.sourceEstimateLine.estimateHasInvoice ||
        r.sourceEstimateLine.unitCost === null
    ) {
        return { status: "unlinkable", totalDelta: null };
    }
    const invoiced = round2(r.sourceEstimateLine.unitCost);
    const received = round2(r.receivedUnitCost);
    if (invoiced === received) {
        return { status: "reconciled", totalDelta: null };
    }
    return {
        status: "mismatch",
        totalDelta: round2((received - invoiced) * r.qty),
    };
}
