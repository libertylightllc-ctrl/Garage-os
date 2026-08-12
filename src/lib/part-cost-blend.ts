import { Prisma } from "@/generated/prisma/client";

/**
 * Blend a part's stored cost with the received unit cost at goods
 * receipt (AR 2026-08-12, profit reporting Phase 1).
 *
 * The rule AR set:
 *   1. qtyOnHand <= 0 OR currentCost is 0 → REPLACE with received cost.
 *      Reasoning: no meaningful history to blend against — either
 *      there's no stock (delivery is the entire population) or the
 *      catalogue value is a seed placeholder that's never been
 *      corrected. Weighted-averaging a zero pulls the result toward
 *      half the real cost, which reads as a "wow, this part got
 *      cheaper" that isn't real.
 *   2. Otherwise → WEIGHTED AVERAGE.
 *          new = ((qtyOnHand × currentCost) + (received × receivedCost))
 *                / (qtyOnHand + received)
 *      Preserves the accounting sense: cost of the stock the shop
 *      now holds is a weighted mean of what it paid to acquire it.
 *
 * All arithmetic runs on Prisma.Decimal (Decimal.js under the hood),
 * never JS number — the moment we cross a division, a float would
 * accumulate rounding error that leaks into ledger reports.
 *
 * Callers pass qty as JS number (an integer, mirrors Part.qtyOnHand's
 * schema type) and receive Decimal | null for the received cost —
 * null is treated as "no cost info, don't touch Part.cost". Return is
 * a new Decimal, rounded to 2 dp to match the Part.cost schema
 * (Decimal(12,2)). A null return is impossible; a receipt without a
 * cost hint returns the currentCost unchanged.
 */

export interface BlendPartCostInput {
    /** Current Part.cost from the DB. */
    currentCost: Prisma.Decimal | string | number;
    /** Current Part.qtyOnHand from the DB. Integer, may be 0 or negative. */
    qtyOnHand: number;
    /** Received unit cost from the PO line. */
    receivedUnitCost: Prisma.Decimal | string | number | null;
    /** Quantity received on this receipt. Integer, > 0. */
    receivedQty: number;
}

export function blendPartCost(input: BlendPartCostInput): Prisma.Decimal {
    const { currentCost, qtyOnHand, receivedUnitCost, receivedQty } = input;

    const current = new Prisma.Decimal(currentCost);
    // Missing receipt cost → don't touch the catalogue. Rare; the
    // receive action refuses to accept a receipt on a line whose
    // unitCost is null, but the helper stays defensive so a future
    // caller can't silently overwrite Part.cost with garbage.
    if (receivedUnitCost === null || receivedUnitCost === undefined) {
        return round2(current);
    }
    const received = new Prisma.Decimal(receivedUnitCost);

    // Guard: receivedQty must be a positive integer. A zero receipt
    // is a no-op at the action level (checked before we get here),
    // but keep the branch so the helper is total.
    if (!Number.isInteger(receivedQty) || receivedQty <= 0) {
        return round2(current);
    }

    // REPLACE branch.
    if (qtyOnHand <= 0 || current.isZero()) {
        return round2(received);
    }

    // WEIGHTED AVERAGE branch.
    //   new = (qtyOnHand × current + receivedQty × received)
    //         / (qtyOnHand + receivedQty)
    const totalQty = new Prisma.Decimal(qtyOnHand).plus(receivedQty);
    const totalCost = new Prisma.Decimal(qtyOnHand)
        .times(current)
        .plus(new Prisma.Decimal(receivedQty).times(received));

    return round2(totalCost.dividedBy(totalQty));
}

function round2(d: Prisma.Decimal): Prisma.Decimal {
    // Half-up to 2 dp — matches Decimal(12,2) storage. Prisma.Decimal
    // uses banker's rounding by default (ROUND_HALF_EVEN); we override
    // to ROUND_HALF_UP to match how the invoice template renders money
    // with .toFixed(2). Difference only shows up on ties (…5), rare
    // for cost blends but consistent with the rest of the app.
    return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
