/**
 * C4a — COGS at invoice generation. AR 2026-09-02.
 *
 * Five tests pin the write behaviour:
 *   1. Flag OFF → invoice generates cleanly, NO COGS pair posted.
 *      Existing INVOICE ledger row shape unchanged.
 *   2. Flag ON + all PART lines have unitCost → COGS pair posted.
 *      DR COGS + CR Inventory = SUM(qty × unitCost). Balanced.
 *   3. Flag ON + a PART line has null unitCost → NO COGS pair.
 *      All-or-nothing per invoice. Invoice still generates.
 *   4. Void an invoice that had a COGS pair → reversing pair
 *      posted under sourceType='INVOICE_COGS_ADJUSTMENT'. Net
 *      across original + reversal = 0.
 *   5. Void an invoice that had NO COGS pair (flag was off) →
 *      only the AR/Sales/VAT reversal fires. No stray
 *      INVOICE_COGS_ADJUSTMENT rows.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        throw new Error("REDIRECT:" + url);
    },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { createCustomerVehicleJobAction } = await import(
    "@/app/actions/intake-moulkia"
);
const {
    createEstimateAction,
    addEstimateLineAction,
    generateInvoiceAction,
    voidInvoiceAction,
    updateInvoiceLineAction,
} = await import("@/app/actions/billing");

const P = "cogs-test-";
const gCogsOff = P + "garage-off";
const gCogsOn = P + "garage-on";

function as(role: string, garageId: string) {
    return { user: { id: P + "u-" + role + "-" + garageId, role, garageId, email: "x", name: "x" } };
}
function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
}
function receptionForm(): FormData {
    return form({
        via: "manual",
        ownerName: "COGS Customer",
        phone: P + Math.random().toString().slice(2, 10),
        plate: "CG-" + Math.random().toString(36).slice(2, 8),
        make: "Toyota",
        model: "Hilux",
        mileageIn: "60000",
        complaint: "Test",
    });
}
async function call(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<string> {
    try {
        await action(fd);
        return "";
    } catch (e) {
        const m = (e as Error).message;
        if (m.startsWith("REDIRECT:")) return m.slice("REDIRECT:".length);
        throw e;
    }
}

async function cleanup() {
    const inGarage = { jobCard: { garageId: { startsWith: P } } };
    await withDeleteGuardBypass(prisma, async (tx) => {
        await tx.payment.deleteMany({ where: { invoice: inGarage } });
        await tx.invoiceLine.deleteMany({ where: { invoice: inGarage } });
        await tx.invoice.deleteMany({ where: { garageId: { startsWith: P } } });
    });
    await prisma.ledgerEntry.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.estimateLine.deleteMany({ where: { estimate: inGarage } });
    await prisma.estimate.deleteMany({ where: inGarage });
    await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.vehicle.deleteMany({ where: { customer: { garageId: { startsWith: P } } } });
    await prisma.whatsAppMessage.deleteMany({ where: { thread: { garageId: { startsWith: P } } } });
    await prisma.whatsAppThread.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}
beforeEach(async () => {
    await cleanup();
    for (const gId of [gCogsOff, gCogsOn]) {
        await prisma.garage.create({
            data: { id: gId, name: gId, cogsEnabled: gId === gCogsOn },
        });
        for (const role of ["OWNER"]) {
            await prisma.user.create({
                data: {
                    id: P + "u-" + role + "-" + gId,
                    garageId: gId,
                    role: role as never,
                    name: role,
                    email: P + "u-" + role + "-" + gId + "@test.local",
                },
            });
        }
    }
    mockAuth.mockReset();
});
afterAll(cleanup);

/** Seed a job with an approved estimate carrying a free-text PART line.
 *
 *  `addEstimateLineAction` ignores the form's unitCost field on free-text
 *  add — that field is only populated by the catalogue prefill branch.
 *  So we add the line via the action (to keep description/qty/price on
 *  the normal path) and then patch unitCost directly, modelling either
 *  a pre-Layer-0 line (null cost) or a Layer-0 line (advisor recorded
 *  the supplier cost). */
async function seedApprovedEstimate(
    garageId: string,
    role: string,
    opts: { partUnitPrice: string; partUnitCost: string | null },
): Promise<string> {
    mockAuth.mockResolvedValue(as(role, garageId));
    const to = await call(createCustomerVehicleJobAction, receptionForm());
    const jobId = to.match(/jobId=([a-z0-9]+)/)![1];

    const estUrl = await call(createEstimateAction, form({ jobId }));
    const estId = estUrl.split("/").pop()!;

    await call(
        addEstimateLineAction,
        form({
            estimateId: estId,
            kind: "PART",
            description: "Test brake pad",
            qty: "2",
            unitPrice: opts.partUnitPrice,
        }),
    );
    await prisma.estimateLine.updateMany({
        where: { estimateId: estId, kind: "PART" },
        data: { unitCost: opts.partUnitCost },
    });
    await prisma.estimate.update({ where: { id: estId }, data: { status: "APPROVED" } });
    return estId;
}

describe("C4a — COGS at invoice generation", { retry: 2 }, () => {
    it("Flag OFF → no COGS pair, invoice ledger unchanged", async () => {
        const estId = await seedApprovedEstimate(gCogsOff, "OWNER", {
            partUnitPrice: "100",
            partUnitCost: "40",
        });
        mockAuth.mockResolvedValue(as("OWNER", gCogsOff));
        const to = await call(generateInvoiceAction, form({ estimateId: estId }));
        const invId = to.split("/").pop()!;

        const invoiceRows = await prisma.ledgerEntry.findMany({
            where: { garageId: gCogsOff, sourceType: "INVOICE", sourceId: invId },
        });
        expect(invoiceRows.length).toBeGreaterThan(0);
        const cogsRows = await prisma.ledgerEntry.findMany({
            where: { garageId: gCogsOff, sourceType: "INVOICE_COGS", sourceId: invId },
        });
        expect(cogsRows.length).toBe(0);
    });

    it("Flag ON + fully costed → COGS pair posted (DR COGS / CR Inventory, balanced)", async () => {
        const estId = await seedApprovedEstimate(gCogsOn, "OWNER", {
            partUnitPrice: "100",
            partUnitCost: "40",
        });
        mockAuth.mockResolvedValue(as("OWNER", gCogsOn));
        const to = await call(generateInvoiceAction, form({ estimateId: estId }));
        const invId = to.split("/").pop()!;

        const cogsRows = await prisma.ledgerEntry.findMany({
            where: { garageId: gCogsOn, sourceType: "INVOICE_COGS", sourceId: invId },
            orderBy: { account: "asc" },
        });
        expect(cogsRows.length).toBe(2);
        const dr = cogsRows.reduce((s, r) => s + Number(r.debit), 0);
        const cr = cogsRows.reduce((s, r) => s + Number(r.credit), 0);
        expect(dr).toBe(80); // 2 qty × 40 cost
        expect(cr).toBe(80);
        const byAcc = new Map(
            cogsRows.map((r) => [r.account, { d: Number(r.debit), c: Number(r.credit) }]),
        );
        expect(byAcc.get(ACCOUNTS.COGS)).toEqual({ d: 80, c: 0 });
        expect(byAcc.get(ACCOUNTS.INVENTORY)).toEqual({ d: 0, c: 80 });
    });

    it("Flag ON + PART line missing unitCost → no COGS pair (all-or-nothing skip)", async () => {
        const estId = await seedApprovedEstimate(gCogsOn, "OWNER", {
            partUnitPrice: "100",
            partUnitCost: null,
        });
        mockAuth.mockResolvedValue(as("OWNER", gCogsOn));
        const to = await call(generateInvoiceAction, form({ estimateId: estId }));
        const invId = to.split("/").pop()!;

        const cogsRows = await prisma.ledgerEntry.findMany({
            where: { garageId: gCogsOn, sourceType: "INVOICE_COGS", sourceId: invId },
        });
        expect(cogsRows.length).toBe(0);
        // Invoice itself still generated + ledger post fired
        const invoiceRows = await prisma.ledgerEntry.findMany({
            where: { garageId: gCogsOn, sourceType: "INVOICE", sourceId: invId },
        });
        expect(invoiceRows.length).toBeGreaterThan(0);
    });

    it("Void invoice with COGS → reversing pair posted, net = 0", async () => {
        const estId = await seedApprovedEstimate(gCogsOn, "OWNER", {
            partUnitPrice: "100",
            partUnitCost: "40",
        });
        mockAuth.mockResolvedValue(as("OWNER", gCogsOn));
        const to = await call(generateInvoiceAction, form({ estimateId: estId }));
        const invId = to.split("/").pop()!;
        // Void requires invoiceDeliveredAt — simulate delivery.
        await prisma.jobCard.updateMany({
            where: { garageId: gCogsOn },
            data: { invoiceDeliveredAt: new Date() },
        });
        mockAuth.mockResolvedValue(as("OWNER", gCogsOn));
        await call(voidInvoiceAction, form({ invoiceId: invId }));

        const cogsRows = await prisma.ledgerEntry.findMany({
            where: { garageId: gCogsOn, sourceId: invId, sourceType: { in: ["INVOICE_COGS", "INVOICE_COGS_ADJUSTMENT"] } },
        });
        // 2 original + 2 reversal = 4
        expect(cogsRows.length).toBe(4);
        const netByAccount = new Map<string, number>();
        for (const r of cogsRows) {
            const net = Number(r.debit) - Number(r.credit);
            netByAccount.set(r.account, (netByAccount.get(r.account) ?? 0) + net);
        }
        expect(netByAccount.get(ACCOUNTS.COGS)).toBe(0);
        expect(netByAccount.get(ACCOUNTS.INVENTORY)).toBe(0);
    });

    it("Three sequential line edits → one COGS pair, not three (recompute replaces, doesn't append)", async () => {
        // AR-called-out load-bearing case: recomputeInvoice runs on
        // every invoice-line edit. If it appended instead of
        // replacing, three qty edits would leave three overlapping
        // COGS pairs and Inventory would go negative by 2× the true
        // COGS. Delete-then-recreate is the whole point.
        const estId = await seedApprovedEstimate(gCogsOn, "OWNER", {
            partUnitPrice: "100",
            partUnitCost: "40",
        });
        mockAuth.mockResolvedValue(as("OWNER", gCogsOn));
        const to = await call(generateInvoiceAction, form({ estimateId: estId }));
        const invId = to.split("/").pop()!;

        // Grab the frozen InvoiceLine — we'll edit its qty via the
        // real action three times.
        const line = await prisma.invoiceLine.findFirst({
            where: { invoiceId: invId, kind: "PART" },
        });
        expect(line, "InvoiceLine should exist post-generation").toBeTruthy();

        for (const qty of ["3", "5", "7"]) {
            mockAuth.mockResolvedValue(as("OWNER", gCogsOn));
            await call(
                updateInvoiceLineAction,
                form({
                    invoiceId: invId,
                    lineId: line!.id,
                    kind: "PART",
                    description: line!.description,
                    qty,
                    unitPrice: "100",
                }),
            );
        }

        // After three recomputes, exactly ONE COGS pair should exist,
        // reflecting the final qty (7 × 40 = 280).
        const cogsRows = await prisma.ledgerEntry.findMany({
            where: { garageId: gCogsOn, sourceType: "INVOICE_COGS", sourceId: invId },
        });
        expect(cogsRows.length).toBe(2);
        const dr = cogsRows.reduce((s, r) => s + Number(r.debit), 0);
        const cr = cogsRows.reduce((s, r) => s + Number(r.credit), 0);
        expect(dr).toBe(280);
        expect(cr).toBe(280);
    });

    it("Void invoice WITHOUT COGS (flag was off) → no INVOICE_COGS_ADJUSTMENT rows", async () => {
        const estId = await seedApprovedEstimate(gCogsOff, "OWNER", {
            partUnitPrice: "100",
            partUnitCost: "40",
        });
        mockAuth.mockResolvedValue(as("OWNER", gCogsOff));
        const to = await call(generateInvoiceAction, form({ estimateId: estId }));
        const invId = to.split("/").pop()!;
        await prisma.jobCard.updateMany({
            where: { garageId: gCogsOff },
            data: { invoiceDeliveredAt: new Date() },
        });
        mockAuth.mockResolvedValue(as("OWNER", gCogsOff));
        await call(voidInvoiceAction, form({ invoiceId: invId }));

        const cogsAdjRows = await prisma.ledgerEntry.findMany({
            where: {
                garageId: gCogsOff,
                sourceId: invId,
                sourceType: "INVOICE_COGS_ADJUSTMENT",
            },
        });
        expect(cogsAdjRows.length).toBe(0);
        // But regular INVOICE_VOID reversal DID fire
        const voidRows = await prisma.ledgerEntry.findMany({
            where: { garageId: gCogsOff, sourceType: "INVOICE_VOID", sourceId: invId },
        });
        expect(voidRows.length).toBeGreaterThan(0);
    });
});
