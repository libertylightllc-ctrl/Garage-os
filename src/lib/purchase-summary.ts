/**
 * Purchase summary (E6, AR 2026-09-03).
 *
 * "What did I buy and what did I pay?" — an operator surface, not
 * a Form 201 support tool. Owner + MASTER both open it. Same
 * ledger-first discipline as the P&L and VAT summary (rule 13 / 14):
 * money numbers read from LedgerEntry, part-level detail joins
 * through the writers' snapshots (PartMovement.partId + unitCost,
 * captured at receive time — no live Part.cost lookups).
 *
 * Structure for a date range:
 *
 *   Totals
 *     Purchased  — sum of CR AP for sourceType='SUPPLIER_BILL' in
 *                  period, netted with SUPPLIER_BILL_ADJUSTMENT.
 *                  Direct-fit spend does NOT flow through AP
 *                  (rule 10) and is NOT included here.
 *     Paid       — sum of DR AP for sourceType='SUPPLIER_PAYMENT_
 *                  ALLOCATION' in period.
 *
 *   By supplier
 *     purchased / paid / outstanding
 *     — each metric joins to Supplier via SupplierBill.supplierId
 *       (for purchase side) or via allocation → bill → supplier
 *       (for payment side).
 *
 *   By part (stock only — direct-fit deliberately excluded)
 *     qty + spend
 *     — PartMovement kind='PO_RECEIPT' + 'PO_RETURN' in period,
 *       grouped by partId. Returns net against receives on the
 *       same partId so a shop that received 10 and returned 2
 *       reads as 8 units × unitCost.
 *
 *   Coverage
 *     byPartSpendCovered  — sum of PartMovement.qty × unitCost
 *                            where unitCost is not null. Historical
 *                            (pre-E6) PO_RECEIPT rows have null
 *                            unitCost and don't contribute to
 *                            spend, only to qty.
 *     directFitSpend      — sum of JobPartReceipt.qty ×
 *                            receivedUnitCost in period. Money the
 *                            shop paid suppliers for direct-fit
 *                            parts but that lives outside AP and
 *                            outside the by-part breakdown. Shown
 *                            in the coverage banner so an owner
 *                            comparing "total purchased" to
 *                            "by-part total" understands the gap.
 *
 * Half-open interval [from, to). Coerces -0 → +0 for display.
 */

import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";

export interface SupplierRow {
    supplierId: string;
    supplierName: string;
    purchased: number;
    paid: number;
    outstanding: number;
}

export interface PartRow {
    partId: string;
    /** part.name — display fallback when sku is blank. */
    name: string;
    /** part.sku — display alongside the name. */
    sku: string | null;
    /** Net qty received in the period (receives − returns). */
    qty: number;
    /** Sum of qty × unitCost for movements whose unitCost is captured. Null when EVERY movement for this part is pre-E6 (no cost captured). */
    spend: number | null;
    /** True when at least one movement for this part has a null unitCost — the spend number under-reports. */
    hasUncostedMovements: boolean;
}

export interface PurchaseCoverage {
    /** Sum of PartMovement.qty × unitCost for the period where unitCost is not null. */
    byPartSpendCovered: number;
    /** Sum of JobPartReceipt.qty × receivedUnitCost — direct-fit spend NOT in the by-part breakdown. */
    directFitSpend: number;
    /** Count of movements in period whose unitCost is null (historical pre-E6 or free-text). */
    uncostedMovementCount: number;
    /** Count of direct-fit receipts in period. */
    directFitReceiptCount: number;
}

export interface PurchaseSummaryResult {
    fromDate: Date;
    toDate: Date;
    totalPurchased: number;
    totalPaid: number;
    bySupplier: SupplierRow[];
    byPart: PartRow[];
    coverage: PurchaseCoverage;
}

function normZero(n: number): number {
    return n + 0;
}
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export async function computePurchaseSummary(
    garageId: string,
    fromDate: Date,
    toDate: Date,
): Promise<PurchaseSummaryResult> {
    // Ledger reads for money numbers (rule 13/14). Two per-source-type
    // pulls against AP.
    const [apInvoiceRows, apPaymentRows, apAdjustmentRows] = await Promise.all([
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                account: ACCOUNTS.AP,
                sourceType: "SUPPLIER_BILL",
                createdAt: { gte: fromDate, lt: toDate },
            },
            select: { sourceId: true, debit: true, credit: true },
        }),
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                account: ACCOUNTS.AP,
                sourceType: "SUPPLIER_PAYMENT_ALLOCATION",
                createdAt: { gte: fromDate, lt: toDate },
            },
            select: { sourceId: true, debit: true, credit: true },
        }),
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                account: ACCOUNTS.AP,
                sourceType: "SUPPLIER_BILL_ADJUSTMENT",
                createdAt: { gte: fromDate, lt: toDate },
            },
            select: { sourceId: true, debit: true, credit: true },
        }),
    ]);

    // Join sources back to their supplier. Bills know their supplier
    // directly; payment allocations resolve supplier via bill.
    const billIds = Array.from(
        new Set([...apInvoiceRows, ...apAdjustmentRows].map((r) => r.sourceId)),
    );
    const allocationIds = Array.from(new Set(apPaymentRows.map((r) => r.sourceId)));
    const [bills, allocations] = await Promise.all([
        billIds.length
            ? prisma.supplierBill.findMany({
                  where: { id: { in: billIds } },
                  select: { id: true, supplierId: true, supplier: { select: { name: true } } },
              })
            : [],
        allocationIds.length
            ? prisma.supplierPaymentAllocation.findMany({
                  where: { id: { in: allocationIds } },
                  select: {
                      id: true,
                      supplierBill: { select: { supplierId: true, supplier: { select: { name: true } } } },
                  },
              })
            : [],
    ]);

    const billMeta = new Map(bills.map((b) => [b.id, b] as const));
    const allocMeta = new Map(allocations.map((a) => [a.id, a] as const));

    // Bucket money by supplier. AP is CR-normal — a bill CRs it (money
    // now owed), a payment/adjustment DRs it (money now settled).
    const bySupplierAcc = new Map<
        string,
        { name: string; purchased: number; paid: number }
    >();
    const bump = (
        supplierId: string,
        name: string,
        field: "purchased" | "paid",
        amount: number,
    ) => {
        const cur = bySupplierAcc.get(supplierId) ?? { name, purchased: 0, paid: 0 };
        cur[field] += amount;
        bySupplierAcc.set(supplierId, cur);
    };

    for (const r of apInvoiceRows) {
        const meta = billMeta.get(r.sourceId);
        if (!meta) continue;
        const purchased = Number(r.credit) - Number(r.debit);
        bump(meta.supplierId, meta.supplier.name, "purchased", purchased);
    }
    for (const r of apAdjustmentRows) {
        // Adjustment (bill void) DRs AP → subtract from purchased.
        const meta = billMeta.get(r.sourceId);
        if (!meta) continue;
        const purchased = Number(r.credit) - Number(r.debit);
        bump(meta.supplierId, meta.supplier.name, "purchased", purchased);
    }
    for (const r of apPaymentRows) {
        const meta = allocMeta.get(r.sourceId);
        if (!meta) continue;
        const paid = Number(r.debit) - Number(r.credit);
        bump(meta.supplierBill.supplierId, meta.supplierBill.supplier.name, "paid", paid);
    }

    // Outstanding per supplier = the supplier's current AP balance
    // across ALL time (not just the period). "What do I still owe
    // this supplier right now" is the operator question — not
    // "what did I owe as of the end of Q3". Same as /owner/payables.
    const allBills = await prisma.supplierBill.findMany({
        where: {
            garageId,
            status: { not: "VOID" },
        },
        select: {
            supplierId: true,
            total: true,
            paidAmount: true,
        },
    });
    const outstandingBySupplier = new Map<string, number>();
    for (const b of allBills) {
        const owed = Number(b.total) - Number(b.paidAmount);
        outstandingBySupplier.set(b.supplierId, (outstandingBySupplier.get(b.supplierId) ?? 0) + owed);
    }

    const bySupplier: SupplierRow[] = [];
    const supplierIds = new Set<string>([
        ...bySupplierAcc.keys(),
        ...outstandingBySupplier.keys(),
    ]);
    for (const supplierId of supplierIds) {
        const acc = bySupplierAcc.get(supplierId);
        const outstanding = round2(outstandingBySupplier.get(supplierId) ?? 0);
        const purchased = round2(acc?.purchased ?? 0);
        const paid = round2(acc?.paid ?? 0);
        if (purchased === 0 && paid === 0 && outstanding === 0) continue;
        const name = acc?.name ?? (await supplierName(supplierId));
        bySupplier.push({
            supplierId,
            supplierName: name,
            purchased: normZero(purchased),
            paid: normZero(paid),
            outstanding: normZero(outstanding),
        });
    }
    bySupplier.sort((a, b) => b.purchased - a.purchased || a.supplierName.localeCompare(b.supplierName));

    // ── by-part (stock only) ────────────────────────────────────────
    // Fetch all PO_RECEIPT + PO_RETURN movements in period. Group by
    // partId, sum(delta) for qty, sum(delta × unitCost) for spend.
    // Any movement with null unitCost contributes to qty but is
    // flagged as uncosted — spend under-reports until the operator
    // opens the PO and re-receives (which they can't, retrospectively;
    // the coverage note is the honest surface).
    const movements = await prisma.partMovement.findMany({
        where: {
            garageId,
            kind: { in: ["PO_RECEIPT", "PO_RETURN"] },
            createdAt: { gte: fromDate, lt: toDate },
        },
        select: {
            partId: true,
            delta: true,
            unitCost: true,
            part: { select: { name: true, sku: true } },
        },
    });

    const byPartAcc = new Map<
        string,
        { name: string; sku: string | null; qty: number; spend: number; hasCost: boolean; hasUncosted: boolean }
    >();
    let uncostedMovementCount = 0;
    for (const m of movements) {
        const cur = byPartAcc.get(m.partId) ?? {
            name: m.part.name,
            sku: m.part.sku,
            qty: 0,
            spend: 0,
            hasCost: false,
            hasUncosted: false,
        };
        cur.qty += m.delta;
        if (m.unitCost !== null) {
            cur.spend += m.delta * Number(m.unitCost);
            cur.hasCost = true;
        } else {
            cur.hasUncosted = true;
            uncostedMovementCount++;
        }
        byPartAcc.set(m.partId, cur);
    }

    const byPart: PartRow[] = [];
    for (const [partId, v] of byPartAcc) {
        if (v.qty === 0 && v.spend === 0) continue;
        byPart.push({
            partId,
            name: v.name,
            sku: v.sku,
            qty: v.qty,
            spend: v.hasCost ? normZero(round2(v.spend)) : null,
            hasUncostedMovements: v.hasUncosted,
        });
    }
    byPart.sort((a, b) => {
        const bSpend = b.spend ?? 0;
        const aSpend = a.spend ?? 0;
        return bSpend - aSpend || a.name.localeCompare(b.name);
    });

    // ── direct-fit coverage ─────────────────────────────────────────
    // JobPartReceipt is the direct-fit half — parts that landed
    // straight on a customer's job without hitting inventory (rule 10:
    // direct-fit lines don't post to AP). Sum their spend so the
    // banner can name the gap between "total purchased" (AP-only)
    // and "by-part breakdown" (stock-only).
    const directFits = await prisma.jobPartReceipt.findMany({
        where: {
            jobCard: { garageId },
            createdAt: { gte: fromDate, lt: toDate },
        },
        select: { qty: true, receivedUnitCost: true },
    });
    let directFitSpend = 0;
    for (const d of directFits) directFitSpend += d.qty * Number(d.receivedUnitCost);
    directFitSpend = normZero(round2(directFitSpend));

    // ── top-line totals ─────────────────────────────────────────────
    // Purchased = AP CR from SUPPLIER_BILL + adjustments (nets voids).
    // Paid      = AP DR from SUPPLIER_PAYMENT_ALLOCATION.
    let totalPurchased = 0;
    for (const r of apInvoiceRows) totalPurchased += Number(r.credit) - Number(r.debit);
    for (const r of apAdjustmentRows) totalPurchased += Number(r.credit) - Number(r.debit);
    let totalPaid = 0;
    for (const r of apPaymentRows) totalPaid += Number(r.debit) - Number(r.credit);
    totalPurchased = normZero(round2(totalPurchased));
    totalPaid = normZero(round2(totalPaid));

    const byPartSpendCovered = normZero(
        round2(byPart.reduce((s, r) => s + (r.spend ?? 0), 0)),
    );

    return {
        fromDate,
        toDate,
        totalPurchased,
        totalPaid,
        bySupplier,
        byPart,
        coverage: {
            byPartSpendCovered,
            directFitSpend,
            uncostedMovementCount,
            directFitReceiptCount: directFits.length,
        },
    };
}

async function supplierName(supplierId: string): Promise<string> {
    const s = await prisma.supplier.findUnique({
        where: { id: supplierId },
        select: { name: true },
    });
    return s?.name ?? "Unknown supplier";
}
