import { Prisma } from "@/generated/prisma/client";

/**
 * Cost snapshot at invoice generation (AR 2026-08-12, corrects Step 6
 * of cost-based pricing).
 *
 * When an invoice is generated from an approved estimate, each
 * InvoiceLine.unitCost is frozen for the life of the invoice — later
 * PO receipts (which may move Part.cost via the weighted-average
 * blend) MUST NOT rewrite the cost on a job already closed.
 *
 * The correct value to freeze is the cost as it stands AT THE MOMENT
 * OF INVOICING, not the cost the advisor saw when pricing the
 * estimate line. Between approval and invoicing, a receipt could
 * have moved Part.cost; the invoice should reflect that receipt.
 *
 * Rule:
 *   • Line has a catalog partId → use current Part.cost from the map.
 *     A cost of zero stays zero (the shop hasn't received any yet,
 *     or logged it as free).
 *   • Line has no partId (free-text) → use the estimate's stored
 *     unitCost. Nothing to look up.
 *
 * The map is built once per generateInvoiceAction call by fetching
 * every referenced Part row and reading its cost.
 */

export interface CostSnapshotLine {
    partId: string | null;
    unitCost: Prisma.Decimal | null;
}

export function resolveInvoiceLineCost(
    line: CostSnapshotLine,
    livePartCostByPartId: Map<string, Prisma.Decimal>,
): Prisma.Decimal | null {
    if (line.partId && livePartCostByPartId.has(line.partId)) {
        return livePartCostByPartId.get(line.partId)!;
    }
    return line.unitCost;
}
