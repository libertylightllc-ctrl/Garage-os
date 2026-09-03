/**
 * E5 — Trial balance + balance sheet. AR 2026-09-03.
 *
 * Pins:
 *   1. Zero activity → everything zero, no rows, balanced trivially.
 *   2. One invoice → assets=210, liabilities=10 (VAT payable),
 *      accumulatedProfit=200 (revenue side), balances.
 *   3. Invoice + payment → cash moves from AR to Cash, still balanced.
 *   4. Expense → expenses on P&L reduce accumulated profit.
 *   5. Trial balance totals: Sum(DR) == Sum(CR).
 *   6. Coverage: cogsFlagOff + invoicesTotal + invoicesCosted counts
 *      exactly the P&L's discipline, cumulative across all time
 *      (not period-scoped).
 *   7. Deliberately-imbalanced ledger → outOfBalanceBy renders the
 *      real delta rather than plugging.
 *   8. asOf date filter — post-cutoff ledger rows excluded.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";
import { computeStatements } from "@/lib/statements";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";

const P = "stmt-test-";
const gId = P + "garage";

async function cleanup() {
    await withDeleteGuardBypass(prisma, async (tx) => {
        await tx.ledgerEntry.deleteMany({ where: { garageId: { startsWith: P } } });
        await tx.invoice.deleteMany({ where: { garageId: { startsWith: P } } });
    });
    await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.vehicle.deleteMany({
        where: { customer: { garageId: { startsWith: P } } },
    });
    await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

async function seedJobCard(id: string, num: number) {
    const cust = await prisma.customer.create({
        data: { garageId: gId, name: `${id}-c`, phone: `999500${num}`.slice(-10) },
    });
    const veh = await prisma.vehicle.create({
        data: { customerId: cust.id, plate: `STM-${num}`, make: "T", model: "H" },
    });
    return prisma.jobCard.create({
        data: {
            garageId: gId,
            number: num,
            vehicleId: veh.id,
            complaint: id,
            mileageIn: 1,
            status: "APPROVED",
        },
    });
}
beforeEach(async () => {
    await cleanup();
    await prisma.garage.create({ data: { id: gId, name: gId, cogsEnabled: false } });
});
afterAll(cleanup);

const AS_OF = new Date("2027-01-01T00:00:00.000Z");
const IN_HIST = new Date("2026-09-01T12:00:00.000Z");

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
            createdAt: r.at ?? IN_HIST,
        })),
    });
}

describe("computeStatements — E5", () => {
    it("Zero activity → all zeros, no rows, trivially balanced", async () => {
        const s = await computeStatements(gId, AS_OF);
        expect(s.rows).toEqual([]);
        expect(s.totalDebits).toBe(0);
        expect(s.totalCredits).toBe(0);
        expect(s.assets).toBe(0);
        expect(s.liabilities).toBe(0);
        expect(s.accumulatedProfit).toBe(0);
        expect(s.outOfBalanceBy).toBe(0);
    });

    it("One invoice → assets=AR, liabilities=VAT, equity=revenue, balances", async () => {
        await ledger([
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i1" },
        ]);
        const s = await computeStatements(gId, AS_OF);
        expect(s.assets).toBe(210); // AR
        expect(s.liabilities).toBe(10); // VAT Payable
        expect(s.accumulatedProfit).toBe(200); // Sales
        expect(s.outOfBalanceBy).toBe(0);
        expect(s.totalDebits).toBe(210);
        expect(s.totalCredits).toBe(210);
    });

    it("Invoice + full payment → cash moves from AR to Cash, still balanced", async () => {
        await ledger([
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.CASH, debit: 210, sourceType: "PAYMENT", sourceId: "p1" },
            { account: ACCOUNTS.AR, credit: 210, sourceType: "PAYMENT", sourceId: "p1" },
        ]);
        const s = await computeStatements(gId, AS_OF);
        // AR = 210 − 210 = 0, so it doesn't appear in rows (zero balance).
        expect(s.assets).toBe(210); // just Cash now
        expect(s.liabilities).toBe(10);
        expect(s.accumulatedProfit).toBe(200);
        expect(s.outOfBalanceBy).toBe(0);
    });

    it("Expense → accumulated profit shrinks by expense amount", async () => {
        await ledger([
            { account: ACCOUNTS.EXP_RENT, debit: 3000, sourceType: "EXPENSE", sourceId: "e1" },
            { account: ACCOUNTS.CASH, credit: 3000, sourceType: "EXPENSE", sourceId: "e1" },
        ]);
        const s = await computeStatements(gId, AS_OF);
        expect(s.assets).toBe(-3000); // Cash overdrawn (fixture-only scenario)
        expect(s.liabilities).toBe(0);
        expect(s.accumulatedProfit).toBe(-3000); // pure loss
        expect(s.outOfBalanceBy).toBe(0);
    });

    it("Trial balance totals: sum(DR) equals sum(CR)", async () => {
        await ledger([
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.EXP_RENT, debit: 3000, sourceType: "EXPENSE", sourceId: "e1" },
            { account: ACCOUNTS.CASH, credit: 3000, sourceType: "EXPENSE", sourceId: "e1" },
        ]);
        const s = await computeStatements(gId, AS_OF);
        expect(s.totalDebits).toBe(s.totalCredits);
    });

    it("Coverage: cogsFlagOff + counts invoices with/without COGS pair", async () => {
        // Invoice 1: costed (has COGS pair). Invoice 2: uncosted.
        await ledger([
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.COGS, debit: 80, sourceType: "INVOICE_COGS", sourceId: "i1" },
            { account: ACCOUNTS.INVENTORY, credit: 80, sourceType: "INVOICE_COGS", sourceId: "i1" },
            { account: ACCOUNTS.AR, debit: 105, sourceType: "INVOICE", sourceId: "i2" },
            { account: ACCOUNTS.SALES, credit: 100, sourceType: "INVOICE", sourceId: "i2" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 5, sourceType: "INVOICE", sourceId: "i2" },
        ]);
        // Seed 2 invoices for the count. Need a jobCard for FK.
        const job = await seedJobCard("j1", 1);
        await prisma.invoice.createMany({
            data: [
                {
                    id: "i1",
                    garageId: gId,
                    jobCardId: job.id,
                    number: 1,
                    issuedAt: IN_HIST,
                    dueDate: IN_HIST,
                    subtotal: 200,
                    vatAmount: 10,
                    total: 210,
                    status: "SENT",
                },
                {
                    id: "i2",
                    garageId: gId,
                    jobCardId: job.id,
                    number: 2,
                    issuedAt: IN_HIST,
                    dueDate: IN_HIST,
                    subtotal: 100,
                    vatAmount: 5,
                    total: 105,
                    status: "SENT",
                },
            ],
        });
        const s = await computeStatements(gId, AS_OF);
        expect(s.coverage.cogsFlagOff).toBe(true);
        expect(s.coverage.invoicesTotal).toBe(2);
        expect(s.coverage.invoicesCosted).toBe(1);
    });

    it("Deliberately imbalanced ledger → outOfBalanceBy shows the delta, no plug", async () => {
        // Fixture only — production writers never produce this. But if
        // a writer bug did, we'd want the delta visible on the balance
        // sheet rather than papered over. Post a DR without a matching CR.
        await ledger([
            { account: ACCOUNTS.AR, debit: 100, sourceType: "TEST_ORPHAN", sourceId: "x1" },
        ]);
        const s = await computeStatements(gId, AS_OF);
        expect(s.assets).toBe(100);
        expect(s.liabilities).toBe(0);
        expect(s.accumulatedProfit).toBe(0);
        // Assets 100 = Liabilities 0 + Equity 0 + 100 out of balance.
        expect(s.outOfBalanceBy).toBe(100);
    });

    it("asOf filter excludes ledger rows created at or after the cutoff", async () => {
        await ledger([
            { account: ACCOUNTS.AR, debit: 100, sourceType: "INVOICE", sourceId: "i1", at: IN_HIST },
            { account: ACCOUNTS.SALES, credit: 100, sourceType: "INVOICE", sourceId: "i1", at: IN_HIST },
            // These rows land at the cutoff, so excluded.
            { account: ACCOUNTS.AR, debit: 999, sourceType: "INVOICE", sourceId: "i2", at: AS_OF },
            { account: ACCOUNTS.SALES, credit: 999, sourceType: "INVOICE", sourceId: "i2", at: AS_OF },
        ]);
        const s = await computeStatements(gId, AS_OF);
        expect(s.assets).toBe(100);
        expect(s.accumulatedProfit).toBe(100);
    });
});
