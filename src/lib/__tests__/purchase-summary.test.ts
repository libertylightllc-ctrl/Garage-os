/**
 * E6 — Purchase summary computation. AR 2026-09-03.
 *
 * Pins:
 *   1. Zero activity → all zeros, byPart empty, bySupplier empty.
 *   2. One bill in period → totalPurchased matches AP CR, one
 *      supplier row with purchased set.
 *   3. Payment in period → totalPaid matches AP DR, supplier row
 *      shows paid.
 *   4. Bill void (SUPPLIER_BILL_ADJUSTMENT) nets purchased down.
 *   5. Outstanding per supplier = total − paidAmount across ALL
 *      bills (not just in-period).
 *   6. By-part: PO_RECEIPT + PO_RETURN net per partId, qty and
 *      spend.
 *   7. Historical (null unitCost) movement contributes to qty
 *      only; hasUncostedMovements=true; spend under-reports.
 *   8. Direct-fit JobPartReceipt spend surfaces in coverage,
 *      NOT in byPart or totalPurchased.
 *   9. Half-open interval [from, to).
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";
import { computePurchaseSummary } from "@/lib/purchase-summary";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";

const P = "purch-test-";
const gId = P + "garage";
const supplierAId = P + "sup-a";
const supplierBId = P + "sup-b";
const partAId = P + "part-a";
const partBId = P + "part-b";
const poId = P + "po-1";

async function cleanup() {
    await withDeleteGuardBypass(prisma, async (tx) => {
        await tx.ledgerEntry.deleteMany({ where: { garageId: { startsWith: P } } });
        await tx.supplierPaymentAllocation.deleteMany({
            where: { supplierPayment: { garageId: { startsWith: P } } },
        });
        await tx.supplierPayment.deleteMany({ where: { garageId: { startsWith: P } } });
        await tx.supplierBill.deleteMany({ where: { garageId: { startsWith: P } } });
        await tx.jobPartReceipt.deleteMany({
            where: { jobCard: { garageId: { startsWith: P } } },
        });
        await tx.partMovement.deleteMany({ where: { garageId: { startsWith: P } } });
    });
    await prisma.purchaseOrderLine.deleteMany({
        where: { purchaseOrder: { garageId: { startsWith: P } } },
    });
    await prisma.purchaseOrder.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.part.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.supplier.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.vehicle.deleteMany({
        where: { customer: { garageId: { startsWith: P } } },
    });
    await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
    await cleanup();
    await prisma.garage.create({ data: { id: gId, name: gId } });
    await prisma.supplier.create({ data: { id: supplierAId, garageId: gId, name: "Supplier A" } });
    await prisma.supplier.create({ data: { id: supplierBId, garageId: gId, name: "Supplier B" } });
    await prisma.part.create({
        data: { id: partAId, garageId: gId, name: "Brake pad", sku: "BRK-PAD", cost: 0, price: 0 },
    });
    await prisma.part.create({
        data: { id: partBId, garageId: gId, name: "Oil filter", sku: "OIL-FIL", cost: 0, price: 0 },
    });
});
afterAll(cleanup);

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-09-01T00:00:00.000Z");
const IN_P = new Date("2026-08-15T12:00:00.000Z");
const PRE_P = new Date("2026-07-15T12:00:00.000Z");

async function seedBill(opts: {
    id: string;
    supplierId: string;
    total: number;
    paidAmount?: number;
    billDate?: Date;
    status?: "OPEN" | "PARTIALLY_PAID" | "PAID" | "VOID";
}) {
    // Bills need a PurchaseOrder for FK. Create one shared PO if missing.
    await prisma.purchaseOrder.upsert({
        where: { id: poId },
        create: { id: poId, garageId: gId, supplierId: opts.supplierId, reference: "PO-1", status: "RECEIVED" },
        update: {},
    });
    const nextBillNum = (await prisma.supplierBill.count({ where: { garageId: gId } })) + 1;
    return prisma.supplierBill.create({
        data: {
            id: opts.id,
            garageId: gId,
            supplierId: opts.supplierId,
            purchaseOrderId: poId,
            billNumber: nextBillNum,
            billDate: opts.billDate ?? IN_P,
            subtotal: opts.total,
            vatAmount: 0,
            total: opts.total,
            paidAmount: opts.paidAmount ?? 0,
            status: opts.status ?? "OPEN",
        },
    });
}

async function ledger(
    rows: {
        account: string;
        debit?: number;
        credit?: number;
        sourceType: string;
        sourceId: string;
        at?: Date;
    }[],
) {
    await prisma.ledgerEntry.createMany({
        data: rows.map((r) => ({
            garageId: gId,
            account: r.account,
            debit: r.debit ?? 0,
            credit: r.credit ?? 0,
            sourceType: r.sourceType,
            sourceId: r.sourceId,
            createdAt: r.at ?? IN_P,
        })),
    });
}

describe("computePurchaseSummary — E6", () => {
    it("Zero activity → all zeros", async () => {
        const p = await computePurchaseSummary(gId, FROM, TO);
        expect(p.totalPurchased).toBe(0);
        expect(p.totalPaid).toBe(0);
        expect(p.bySupplier).toEqual([]);
        expect(p.byPart).toEqual([]);
        expect(p.coverage.directFitSpend).toBe(0);
        expect(p.coverage.byPartSpendCovered).toBe(0);
    });

    it("One bill in period → totalPurchased set + one supplier row", async () => {
        await seedBill({ id: "b1", supplierId: supplierAId, total: 1000 });
        await ledger([
            { account: ACCOUNTS.INVENTORY, debit: 1000, sourceType: "SUPPLIER_BILL", sourceId: "b1" },
            { account: ACCOUNTS.AP, credit: 1000, sourceType: "SUPPLIER_BILL", sourceId: "b1" },
        ]);
        const p = await computePurchaseSummary(gId, FROM, TO);
        expect(p.totalPurchased).toBe(1000);
        expect(p.totalPaid).toBe(0);
        expect(p.bySupplier).toEqual([
            {
                supplierId: supplierAId,
                supplierName: "Supplier A",
                purchased: 1000,
                paid: 0,
                outstanding: 1000,
            },
        ]);
    });

    it("Payment in period → totalPaid set + supplier row shows paid", async () => {
        const bill = await seedBill({ id: "b1", supplierId: supplierAId, total: 1000, paidAmount: 300 });
        const pay = await prisma.supplierPayment.create({
            data: {
                id: "pay-1",
                garageId: gId,
                supplierId: supplierAId,
                amount: 300,
                method: "Cash",
                paidAt: IN_P,
            },
        });
        await prisma.supplierPaymentAllocation.create({
            data: {
                id: "alloc-1",
                supplierPaymentId: pay.id,
                supplierBillId: bill.id,
                amount: 300,
            },
        });
        await ledger([
            { account: ACCOUNTS.INVENTORY, debit: 1000, sourceType: "SUPPLIER_BILL", sourceId: "b1" },
            { account: ACCOUNTS.AP, credit: 1000, sourceType: "SUPPLIER_BILL", sourceId: "b1" },
            { account: ACCOUNTS.AP, debit: 300, sourceType: "SUPPLIER_PAYMENT_ALLOCATION", sourceId: "alloc-1" },
            { account: ACCOUNTS.CASH, credit: 300, sourceType: "SUPPLIER_PAYMENT_ALLOCATION", sourceId: "alloc-1" },
        ]);
        const p = await computePurchaseSummary(gId, FROM, TO);
        expect(p.totalPurchased).toBe(1000);
        expect(p.totalPaid).toBe(300);
        expect(p.bySupplier[0]).toMatchObject({
            supplierId: supplierAId,
            purchased: 1000,
            paid: 300,
            outstanding: 700, // 1000 total − 300 paidAmount
        });
    });

    it("Bill void (SUPPLIER_BILL_ADJUSTMENT) nets purchased down", async () => {
        await seedBill({ id: "b1", supplierId: supplierAId, total: 1000, status: "VOID" });
        await ledger([
            { account: ACCOUNTS.INVENTORY, debit: 1000, sourceType: "SUPPLIER_BILL", sourceId: "b1" },
            { account: ACCOUNTS.AP, credit: 1000, sourceType: "SUPPLIER_BILL", sourceId: "b1" },
            // Void reversal
            { account: ACCOUNTS.AP, debit: 1000, sourceType: "SUPPLIER_BILL_ADJUSTMENT", sourceId: "b1" },
            { account: ACCOUNTS.INVENTORY, credit: 1000, sourceType: "SUPPLIER_BILL_ADJUSTMENT", sourceId: "b1" },
        ]);
        const p = await computePurchaseSummary(gId, FROM, TO);
        expect(p.totalPurchased).toBe(0);
        // VOID bills excluded from outstanding
        expect(p.bySupplier).toEqual([]);
    });

    it("By-part: PO_RECEIPT + PO_RETURN net per partId, qty + spend", async () => {
        await prisma.partMovement.createMany({
            data: [
                { partId: partAId, garageId: gId, kind: "PO_RECEIPT", delta: 10, unitCost: 40, reason: "receive", createdAt: IN_P },
                { partId: partAId, garageId: gId, kind: "PO_RETURN", delta: -2, unitCost: 40, reason: "return", createdAt: IN_P },
                { partId: partBId, garageId: gId, kind: "PO_RECEIPT", delta: 5, unitCost: 20, reason: "receive", createdAt: IN_P },
            ],
        });
        const p = await computePurchaseSummary(gId, FROM, TO);
        // Sort is by spend desc: brake pad 8×40=320, oil filter 5×20=100.
        expect(p.byPart).toEqual([
            {
                partId: partAId,
                name: "Brake pad",
                sku: "BRK-PAD",
                qty: 8,
                spend: 320,
                hasUncostedMovements: false,
            },
            {
                partId: partBId,
                name: "Oil filter",
                sku: "OIL-FIL",
                qty: 5,
                spend: 100,
                hasUncostedMovements: false,
            },
        ]);
        expect(p.coverage.byPartSpendCovered).toBe(420);
        expect(p.coverage.uncostedMovementCount).toBe(0);
    });

    it("Historical null-unitCost movement → qty counted, spend flagged uncosted", async () => {
        await prisma.partMovement.createMany({
            data: [
                { partId: partAId, garageId: gId, kind: "PO_RECEIPT", delta: 10, unitCost: null, reason: "legacy", createdAt: IN_P },
                { partId: partAId, garageId: gId, kind: "PO_RECEIPT", delta: 5, unitCost: 40, reason: "new", createdAt: IN_P },
            ],
        });
        const p = await computePurchaseSummary(gId, FROM, TO);
        expect(p.byPart[0]).toMatchObject({
            partId: partAId,
            qty: 15, // 10 uncosted + 5 costed
            spend: 200, // only the 5 costed count toward spend
            hasUncostedMovements: true,
        });
        expect(p.coverage.uncostedMovementCount).toBe(1);
    });

    it("Direct-fit JobPartReceipt surfaces in coverage, NOT in byPart or totalPurchased", async () => {
        // Need a jobCard + PO line for the FK chain
        const cust = await prisma.customer.create({ data: { garageId: gId, name: "C", phone: "9990001" } });
        const veh = await prisma.vehicle.create({ data: { customerId: cust.id, plate: "DF-1", make: "T", model: "H" } });
        const job = await prisma.jobCard.create({
            data: { garageId: gId, number: 1, vehicleId: veh.id, complaint: "x", mileageIn: 1, status: "APPROVED" },
        });
        const poLine = await prisma.purchaseOrderLine.create({
            data: {
                purchaseOrderId: (await prisma.purchaseOrder.upsert({
                    where: { id: poId },
                    create: { id: poId, garageId: gId, supplierId: supplierAId, reference: "PO-1", status: "RECEIVED" },
                    update: {},
                })).id,
                partId: null,
                description: "Direct-fit brake pad",
                qty: 2,
                receivedQty: 2,
                unitCost: 50,
            },
        });
        await prisma.jobPartReceipt.create({
            data: {
                jobCardId: job.id,
                purchaseOrderLineId: poLine.id,
                description: "Direct-fit brake pad",
                qty: 2,
                receivedUnitCost: 50,
                createdAt: IN_P,
            },
        });
        const p = await computePurchaseSummary(gId, FROM, TO);
        expect(p.totalPurchased).toBe(0); // no AP row → not in totalPurchased
        expect(p.byPart).toEqual([]); // no PartMovement → not in byPart
        expect(p.coverage.directFitSpend).toBe(100); // 2 × 50 surfaces in coverage
        expect(p.coverage.directFitReceiptCount).toBe(1);
    });

    it("Half-open interval [from, to)", async () => {
        await seedBill({ id: "b-in", supplierId: supplierAId, total: 100, billDate: IN_P });
        await seedBill({ id: "b-boundary", supplierId: supplierAId, total: 999, billDate: TO });
        await ledger([
            { account: ACCOUNTS.AP, credit: 100, sourceType: "SUPPLIER_BILL", sourceId: "b-in", at: IN_P },
            { account: ACCOUNTS.AP, credit: 999, sourceType: "SUPPLIER_BILL", sourceId: "b-boundary", at: TO },
        ]);
        const p = await computePurchaseSummary(gId, FROM, TO);
        expect(p.totalPurchased).toBe(100);
    });
});
