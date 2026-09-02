/**
 * E4 + E4b — VAT summary computation. AR 2026-09-02 / 2026-09-03.
 *
 * Pins the ledger-reading + per-emirate breakdown + adjustments
 * column + coverage-counting behaviour:
 *   1. Zero activity → all zeros, byEmirate empty, coverage zero.
 *   2. Output VAT only, one emirate → single Dubai row, net = output.
 *   3. Input VAT only → inputVat positive, no per-emirate row.
 *   4. Same-quarter void → nets to zero in the Standard column,
 *      Adjustments untouched.
 *   5. Cross-quarter void → posts to Adjustments column of the
 *      original invoice's emirate, NOT the current period's Standard.
 *   6. Null-emirate invoice → renders as "Unassigned" bucket.
 *   7. Cross-quarter void carries the ORIGINAL emirate even when
 *      Garage.emirate has since changed — pinned invariant.
 *   8. Multi-emirate output splits cleanly per emirate.
 *   9. Coverage: invoicesWithEmirate < invoicesInPeriod when any
 *      pre-cutover / null-emirate invoice touched the period.
 *  10. Half-open interval [from, to) still holds.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";
import { computeVatSummary } from "@/lib/vat-summary";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";

const P = "vat-test-";
const gId = P + "garage";

async function cleanup() {
    await withDeleteGuardBypass(prisma, async (tx) => {
        await tx.ledgerEntry.deleteMany({ where: { garageId: { startsWith: P } } });
        await tx.invoiceLine.deleteMany({
            where: { invoice: { garageId: { startsWith: P } } },
        });
        await tx.invoice.deleteMany({ where: { garageId: { startsWith: P } } });
        await tx.$executeRawUnsafe(`SET LOCAL app.allow_expense_delete = 'true'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "Expense" WHERE "garageId" LIKE '${P}%'`,
        );
    });
    await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.vehicle.deleteMany({
        where: { customer: { garageId: { startsWith: P } } },
    });
    await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}
beforeEach(async () => {
    await cleanup();
    await prisma.garage.create({ data: { id: gId, name: gId, emirate: "Dubai" } });
});
afterAll(cleanup);

// Q3 2026 (Jul–Sep).
const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-10-01T00:00:00.000Z");
const IN_Q = new Date("2026-08-15T12:00:00.000Z");
const PRE_Q = new Date("2026-05-15T12:00:00.000Z"); // Q2

/** Create a minimal Invoice row (bypassing generateInvoiceAction) so
 *  the ledger rows below have something to JOIN back to for the
 *  emirate + createdAt fields. */
async function seedInvoice(opts: {
    id: string;
    number: number;
    createdAt: Date;
    emirate: "AbuDhabi" | "Dubai" | "Sharjah" | "Ajman" | "UmmAlQuwain" | "RasAlKhaimah" | "Fujairah" | null;
}) {
    // Need a jobCard for the FK — chain up.
    const cust = await prisma.customer.create({
        data: { garageId: gId, name: `${opts.id}-cust`, phone: `9995000${opts.number}`.slice(-10) },
    });
    const veh = await prisma.vehicle.create({
        data: { customerId: cust.id, plate: `VAT-${opts.number}`, make: "T", model: "H" },
    });
    // JobCard.number is per-garage unique. Test scope uses P prefix so
    // the number domain here starts fresh.
    const job = await prisma.jobCard.create({
        data: {
            garageId: gId,
            number: opts.number,
            vehicleId: veh.id,
            complaint: opts.id,
            mileageIn: 1000,
            status: "APPROVED",
        },
    });
    await prisma.invoice.create({
        data: {
            id: opts.id,
            garageId: gId,
            jobCardId: job.id,
            number: opts.number,
            issuedAt: opts.createdAt,
            createdAt: opts.createdAt,
            dueDate: new Date(opts.createdAt.getTime() + 14 * 24 * 60 * 60 * 1000),
            subtotal: 100,
            vatAmount: 5,
            total: 105,
            emirate: opts.emirate,
            status: "SENT",
        },
    });
}

async function ledger(
    rows: {
        account: string;
        debit?: number;
        credit?: number;
        sourceType?: string;
        sourceId?: string;
        at?: Date;
    }[],
) {
    await prisma.ledgerEntry.createMany({
        data: rows.map((r) => ({
            garageId: gId,
            account: r.account,
            debit: r.debit ?? 0,
            credit: r.credit ?? 0,
            sourceType: r.sourceType ?? "TEST",
            sourceId: r.sourceId ?? "test",
            createdAt: r.at ?? IN_Q,
        })),
    });
}

describe("computeVatSummary — E4 + E4b per-emirate + adjustments", () => {
    it("Zero activity → all zeros, byEmirate empty", async () => {
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.outputVat).toBe(0);
        expect(v.adjustmentsVat).toBe(0);
        expect(v.inputVat).toBe(0);
        expect(v.netPayable).toBe(0);
        expect(v.byEmirate).toEqual([]);
        expect(v.coverage.invoicesInPeriod).toBe(0);
        expect(v.coverage.invoicesWithEmirate).toBe(0);
    });

    it("Output VAT only, single Dubai invoice → one row, net = output", async () => {
        await seedInvoice({ id: "i1", number: 1, createdAt: IN_Q, emirate: "Dubai" });
        await ledger([
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i1" },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.outputVat).toBe(10);
        expect(v.adjustmentsVat).toBe(0);
        expect(v.byEmirate).toEqual([
            { emirate: "Dubai", standardVat: 10, adjustmentVat: 0, netVat: 10 },
        ]);
        expect(v.netPayable).toBe(10);
    });

    it("Input VAT only → inputVat positive, no per-emirate row, net = negative (refund)", async () => {
        await ledger([{ account: ACCOUNTS.VAT_INPUT, debit: 5, sourceType: "EXPENSE", sourceId: "e1" }]);
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.inputVat).toBe(5);
        expect(v.byEmirate).toEqual([]);
        expect(v.netPayable).toBe(-5);
    });

    it("Same-quarter void → nets in Standard column, Adjustments untouched", async () => {
        await seedInvoice({ id: "i1", number: 1, createdAt: IN_Q, emirate: "Dubai" });
        await ledger([
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i1", at: IN_Q },
            // Void in same quarter
            { account: ACCOUNTS.VAT_PAYABLE, debit: 10, sourceType: "INVOICE_VOID", sourceId: "i1", at: IN_Q },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        // 10 collected + 10 reversed both belong in Standard column for
        // Dubai — net 0. Dubai row is elided because both cols are 0.
        expect(v.byEmirate).toEqual([]);
        expect(v.outputVat).toBe(0);
        expect(v.adjustmentsVat).toBe(0);
    });

    it("Cross-quarter void → posts to Adjustments column of ORIGINAL emirate", async () => {
        // Original invoice was raised in Q2, VAT already declared then.
        await seedInvoice({ id: "i-prev", number: 1, createdAt: PRE_Q, emirate: "Sharjah" });
        await ledger([
            // Q2 posts are outside the period we're computing; we don't
            // create ledger rows for them (they're already in Q2's
            // filed return).
            // Q3 void row:
            { account: ACCOUNTS.VAT_PAYABLE, debit: 10, sourceType: "INVOICE_VOID", sourceId: "i-prev", at: IN_Q },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        // Standard: 0 (no invoice raised in Q3). Adjustments: +10 for Sharjah.
        expect(v.byEmirate).toEqual([
            { emirate: "Sharjah", standardVat: 0, adjustmentVat: 10, netVat: -10 },
        ]);
        expect(v.outputVat).toBe(0);
        expect(v.adjustmentsVat).toBe(10);
        // Net = 0 (standard) − 10 (adjustments) − 0 (input) = −10 refund.
        expect(v.netPayable).toBe(-10);
    });

    it("Null-emirate invoice → renders as Unassigned bucket", async () => {
        await seedInvoice({ id: "i-un", number: 1, createdAt: IN_Q, emirate: null });
        await ledger([
            { account: ACCOUNTS.VAT_PAYABLE, credit: 15, sourceType: "INVOICE", sourceId: "i-un" },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.byEmirate).toEqual([
            { emirate: "Unassigned", standardVat: 15, adjustmentVat: 0, netVat: 15 },
        ]);
        expect(v.coverage.invoicesInPeriod).toBe(1);
        expect(v.coverage.invoicesWithEmirate).toBe(0);
    });

    it("Cross-quarter void inherits ORIGINAL emirate even if Garage.emirate changed", async () => {
        // Original raised in Q2 when garage was Sharjah.
        await seedInvoice({ id: "i-old", number: 1, createdAt: PRE_Q, emirate: "Sharjah" });
        // Garage has since moved to Ajman. That's cosmetic — the
        // Invoice row's snapshot is what the JOIN reads.
        await prisma.garage.update({ where: { id: gId }, data: { emirate: "Ajman" } });
        await ledger([
            { account: ACCOUNTS.VAT_PAYABLE, debit: 10, sourceType: "INVOICE_VOID", sourceId: "i-old", at: IN_Q },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        // Adjustment lands in Sharjah (original), NOT Ajman (current garage).
        expect(v.byEmirate).toEqual([
            { emirate: "Sharjah", standardVat: 0, adjustmentVat: 10, netVat: -10 },
        ]);
    });

    it("Multi-emirate output splits cleanly and renders in Form 201 order", async () => {
        await seedInvoice({ id: "i-dxb", number: 1, createdAt: IN_Q, emirate: "Dubai" });
        await seedInvoice({ id: "i-auh", number: 2, createdAt: IN_Q, emirate: "AbuDhabi" });
        await seedInvoice({ id: "i-shj", number: 3, createdAt: IN_Q, emirate: "Sharjah" });
        await ledger([
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i-dxb" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 20, sourceType: "INVOICE", sourceId: "i-auh" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 5, sourceType: "INVOICE", sourceId: "i-shj" },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        // Form 201 order: Abu Dhabi → Dubai → Sharjah.
        expect(v.byEmirate.map((r) => r.emirate)).toEqual(["AbuDhabi", "Dubai", "Sharjah"]);
        expect(v.byEmirate.map((r) => r.standardVat)).toEqual([20, 10, 5]);
        expect(v.outputVat).toBe(35);
    });

    it("Coverage: invoicesWithEmirate < invoicesInPeriod when any invoice has null emirate", async () => {
        await seedInvoice({ id: "i-dxb", number: 1, createdAt: IN_Q, emirate: "Dubai" });
        await seedInvoice({ id: "i-un", number: 2, createdAt: IN_Q, emirate: null });
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.coverage.invoicesInPeriod).toBe(2);
        expect(v.coverage.invoicesWithEmirate).toBe(1);
    });

    it("Half-open interval [from, to) — void row at exactly `to` excluded", async () => {
        await seedInvoice({ id: "i-boundary", number: 1, createdAt: PRE_Q, emirate: "Dubai" });
        await ledger([
            { account: ACCOUNTS.VAT_PAYABLE, debit: 999, sourceType: "INVOICE_VOID", sourceId: "i-boundary", at: TO },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        // Row at exactly `to` excluded — Adjustments untouched.
        expect(v.adjustmentsVat).toBe(0);
    });
});
