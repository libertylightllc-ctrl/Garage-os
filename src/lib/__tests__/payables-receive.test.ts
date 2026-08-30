/**
 * Payables C3 — receive → AP.
 *
 * Five tests that pin the extension to receivePurchaseOrderAction:
 *
 *   1. Flag OFF → receive path unchanged. Stock moves, PartMovement
 *      writes, PO status flips — and NO SupplierBill, NO LedgerEntry
 *      rows land. Exact behaviour parity with the pre-C3 code.
 *
 *   2. Flag ON → receive creates a SupplierBill and posts DR
 *      Inventory + DR VAT-Input / CR AP. Ledger balances to zero.
 *      Subtotal + VAT + total match the auto-calc from Garage.vatRate.
 *
 *   3. LOAD-BEARING: flag ON + bill creation throws (billNumber
 *      collision via a pre-inserted row) → the ENTIRE receive
 *      transaction rolls back. Stock unchanged, POLine.receivedQty
 *      unchanged, no PartMovement, no ledger rows. This is the
 *      failure-isolation proof AR asked for by name — proven, not
 *      reasoned.
 *
 *   4. Flag ON + VAT override → override wins over the auto-calc.
 *      Matches the "supplier's actual tax invoice is source of truth"
 *      rule from AR 2026-08-30.
 *
 *   5. Flag ON + all-null-cost lines → subtotal = 0 → no bill row,
 *      no ledger post. Receive still lands (stock moves). Same
 *      "don't fake missing cost" discipline as elsewhere.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        throw new Error("REDIRECT:" + url);
    },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-user", () => ({ sessionUserExists: async () => true }));

const { receivePurchaseOrderAction } = await import("@/app/actions/purchasing");

const P = "payables-c3-";
const gOff = P + "garage-off";
const gOn = P + "garage-on";

function owner(garageId: string) {
    return { user: { id: P + "u", role: "OWNER", garageId, email: "x", name: "x" } };
}
function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
}
async function call(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<string> {
    try {
        await action(fd);
        return "(no redirect)";
    } catch (e) {
        const m = (e as Error).message;
        if (m.startsWith("REDIRECT:")) return m.slice("REDIRECT:".length);
        throw e;
    }
}

async function seedPo(garageId: string, opts: {
    unitCost: string | null;
    qty?: number;
}): Promise<{ poId: string; lineId: string; partId: string; supplierId: string }> {
    const s = await prisma.supplier.create({ data: { garageId, name: P + "supp" } });
    const p = await prisma.part.create({
        data: { garageId, sku: P + Math.random().toString(36).slice(2, 8), name: "P", cost: "5", price: "9", qtyOnHand: 0 },
    });
    const po = await prisma.purchaseOrder.create({
        data: {
            garageId,
            supplierId: s.id,
            status: "ORDERED",
            orderedAt: new Date(),
        },
    });
    const line = await prisma.purchaseOrderLine.create({
        data: {
            purchaseOrderId: po.id,
            partId: p.id,
            qty: opts.qty ?? 10,
            receivedQty: 0,
            unitCost: opts.unitCost,
        },
    });
    return { poId: po.id, lineId: line.id, partId: p.id, supplierId: s.id };
}

async function cleanup() {
    await prisma.ledgerEntry.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.supplierPaymentAllocation.deleteMany({
        where: { supplierPayment: { garageId: { startsWith: P } } },
    });
    await prisma.supplierPayment.deleteMany({ where: { garageId: { startsWith: P } } });
    // SupplierBill delete needs the trigger flag set (from C2 guard) —
    // set it as a session flag before the DELETE inside the same tx.
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.allow_supplier_bill_delete = 'true'`);
        await tx.$executeRawUnsafe(`DELETE FROM "SupplierBill" WHERE "garageId" LIKE '${P}%'`);
    });
    await prisma.partMovement.deleteMany({ where: { part: { garageId: { startsWith: P } } } });
    await prisma.purchaseOrderLine.deleteMany({
        where: { purchaseOrder: { garageId: { startsWith: P } } },
    });
    await prisma.purchaseOrder.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.part.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.supplier.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
    await cleanup();
    await prisma.garage.create({
        data: { id: gOff, name: P + "OFF", payablesEnabled: false, vatRate: "0.05" },
    });
    await prisma.garage.create({
        data: { id: gOn, name: P + "ON", payablesEnabled: true, vatRate: "0.05" },
    });
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("receivePurchaseOrderAction — Payables C3", { retry: 2 }, () => {
    it("Flag OFF → no bill, no ledger, exact pre-C3 behaviour", async () => {
        const { poId, lineId, partId } = await seedPo(gOff, { unitCost: "12.00", qty: 10 });
        mockAuth.mockResolvedValueOnce(owner(gOff));
        await call(receivePurchaseOrderAction, form({ poId, [`recv_${lineId}`]: "10" }));

        const bills = await prisma.supplierBill.findMany({ where: { garageId: gOff } });
        const entries = await prisma.ledgerEntry.findMany({ where: { garageId: gOff } });
        const stock = await prisma.part.findUnique({ where: { id: partId } });
        const line = await prisma.purchaseOrderLine.findUnique({ where: { id: lineId } });

        expect(bills.length).toBe(0);
        expect(entries.length).toBe(0);
        expect(stock?.qtyOnHand).toBe(10);
        expect(line?.receivedQty).toBe(10);
    });

    it("Flag ON → bill created, ledger balanced (DR Inventory + DR VAT / CR AP)", async () => {
        const { poId, lineId, partId, supplierId } = await seedPo(gOn, { unitCost: "12.00", qty: 10 });
        mockAuth.mockResolvedValueOnce(owner(gOn));
        await call(receivePurchaseOrderAction, form({ poId, [`recv_${lineId}`]: "10" }));

        const bills = await prisma.supplierBill.findMany({ where: { garageId: gOn } });
        expect(bills.length).toBe(1);
        const b = bills[0];
        expect(Number(b.subtotal)).toBe(120); // 10 × 12
        expect(Number(b.vatAmount)).toBe(6); // 120 × 0.05
        expect(Number(b.total)).toBe(126);
        expect(b.supplierId).toBe(supplierId);
        expect(b.purchaseOrderId).toBe(poId);
        expect(b.billNumber).toBe(1);

        const entries = await prisma.ledgerEntry.findMany({
            where: { garageId: gOn, sourceId: b.id },
            orderBy: { account: "asc" },
        });
        // Sum debits == sum credits (balanced).
        const dr = entries.reduce((s, e) => s + Number(e.debit), 0);
        const cr = entries.reduce((s, e) => s + Number(e.credit), 0);
        expect(dr).toBe(126);
        expect(cr).toBe(126);

        // Named-account shape.
        const byAccount = new Map(entries.map((e) => [e.account, { d: Number(e.debit), c: Number(e.credit) }]));
        expect(byAccount.get(ACCOUNTS.INVENTORY)).toEqual({ d: 120, c: 0 });
        expect(byAccount.get(ACCOUNTS.VAT_INPUT)).toEqual({ d: 6, c: 0 });
        expect(byAccount.get(ACCOUNTS.AP)).toEqual({ d: 0, c: 126 });

        // Stock + POLine still advanced correctly.
        const stock = await prisma.part.findUnique({ where: { id: partId } });
        expect(stock?.qtyOnHand).toBe(10);
    });

    it("LOAD-BEARING: bill creation throws → whole receive rolls back (stock unchanged)", async () => {
        const { poId, lineId, partId, supplierId } = await seedPo(gOn, { unitCost: "12.00", qty: 10 });

        // Pre-seed billSeq counter + collide billNumber. The receive's
        // increment picks billNumber = 1, insert fails on
        // @@unique([garageId, billNumber]), tx rolls back.
        await prisma.supplierBill.create({
            data: {
                garageId: gOn,
                supplierId,
                purchaseOrderId: poId,
                billNumber: 1,
                billDate: new Date(),
                subtotal: 1,
                vatAmount: 0,
                total: 1,
            },
        });
        // Reset counter so garage.update picks 1 on increment (start value 0 + 1 = 1).
        await prisma.garage.update({ where: { id: gOn }, data: { billSeq: 0 } });

        mockAuth.mockResolvedValueOnce(owner(gOn));
        const to = await call(receivePurchaseOrderAction, form({ poId, [`recv_${lineId}`]: "10" }));
        // Action throws on the unique-constraint violation. The
        // action doesn't catch it — Next surfaces as an error redirect
        // or a raw throw depending on hosting. We just verify state.
        void to;

        // Nothing advanced.
        const stock = await prisma.part.findUnique({ where: { id: partId } });
        expect(stock?.qtyOnHand).toBe(0); // <-- the failure-isolation proof
        const line = await prisma.purchaseOrderLine.findUnique({ where: { id: lineId } });
        expect(line?.receivedQty).toBe(0);
        const movements = await prisma.partMovement.findMany({ where: { partId } });
        expect(movements.length).toBe(0);
        // Only the ONE pre-seeded bill exists; no C3-created bill.
        const bills = await prisma.supplierBill.findMany({ where: { garageId: gOn } });
        expect(bills.length).toBe(1);
        expect(bills[0].billNumber).toBe(1);
        expect(Number(bills[0].subtotal)).toBe(1); // the pre-seeded shape, not our attempt
    });

    it("VAT override wins over auto-calc", async () => {
        const { poId, lineId } = await seedPo(gOn, { unitCost: "100.00", qty: 1 });
        mockAuth.mockResolvedValueOnce(owner(gOn));
        // Auto-calc would be 100 × 0.05 = 5. Override: 4.76 (typical
        // rounding difference on a real supplier invoice).
        await call(
            receivePurchaseOrderAction,
            form({ poId, [`recv_${lineId}`]: "1", billVatAmount: "4.76" }),
        );

        const bills = await prisma.supplierBill.findMany({ where: { garageId: gOn } });
        expect(bills.length).toBe(1);
        expect(Number(bills[0].subtotal)).toBe(100);
        expect(Number(bills[0].vatAmount)).toBe(4.76);
        expect(Number(bills[0].total)).toBe(104.76);
    });

    it("Flag ON + null-cost line only → no bill (skip on subtotal=0)", async () => {
        // Legacy pre-Layer-0 line with unitCost = null. Receive still
        // moves stock; bill creation skips because subtotal would be 0.
        const { poId, lineId, partId } = await seedPo(gOn, { unitCost: null, qty: 3 });
        mockAuth.mockResolvedValueOnce(owner(gOn));
        await call(receivePurchaseOrderAction, form({ poId, [`recv_${lineId}`]: "3" }));

        const bills = await prisma.supplierBill.findMany({ where: { garageId: gOn } });
        const entries = await prisma.ledgerEntry.findMany({ where: { garageId: gOn } });
        expect(bills.length).toBe(0);
        expect(entries.length).toBe(0);
        // Receive itself still landed.
        const stock = await prisma.part.findUnique({ where: { id: partId } });
        expect(stock?.qtyOnHand).toBe(3);
    });
});
