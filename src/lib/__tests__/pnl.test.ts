/**
 * E3a — P&L computation. AR 2026-09-02.
 *
 * Six tests pin the report shape:
 *   1. Zero-activity garage → all zeros, no revenue/expense lines,
 *      gross+net margin = null (not NaN or 0%).
 *   2. Revenue only (no COGS, no expenses) → gross profit = revenue,
 *      gross margin = 100%.
 *   3. Revenue + matching COGS pair → gross profit = subtotal − cost,
 *      correct margin, coverage shows 1/1 invoices costed.
 *   4. Revenue with COGS flag OFF → gross profit = revenue,
 *      coverage.cogsFlagOff = true (so the page can say WHY there's
 *      no COGS line).
 *   5. Expenses only → net profit = negative expenses, gross profit = 0.
 *   6. Zero-balance categories don't show as lines (an expense account
 *      never touched during the period is not rendered as "AED 0.00").
 *
 * Half-open interval: rows at exactly `toDate` are EXCLUDED, rows at
 * `fromDate` are INCLUDED. Test 7 pins this on both edges.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";
import { computePnl } from "@/lib/pnl";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";

const P = "pnl-test-";
const gCold = P + "garage-cold";
const gWarm = P + "garage-warm";

async function cleanup() {
    await withDeleteGuardBypass(prisma, async (tx) => {
        await tx.ledgerEntry.deleteMany({ where: { garageId: { startsWith: P } } });
    });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}
beforeEach(async () => {
    await cleanup();
    await prisma.garage.create({ data: { id: gCold, name: gCold, cogsEnabled: false } });
    await prisma.garage.create({ data: { id: gWarm, name: gWarm, cogsEnabled: true } });
});
afterAll(cleanup);

const FROM = new Date("2026-09-01T00:00:00.000Z");
const TO = new Date("2026-10-01T00:00:00.000Z");
const IN_PERIOD = new Date("2026-09-15T12:00:00.000Z");

async function seedLedger(
    garageId: string,
    rows: { account: string; debit?: number; credit?: number; sourceType?: string; sourceId?: string; at?: Date }[],
) {
    await prisma.ledgerEntry.createMany({
        data: rows.map((r) => ({
            garageId,
            account: r.account,
            debit: r.debit ?? 0,
            credit: r.credit ?? 0,
            sourceType: r.sourceType ?? "TEST",
            sourceId: r.sourceId ?? "test",
            createdAt: r.at ?? IN_PERIOD,
        })),
    });
}

describe("computePnl", () => {
    it("Zero-activity garage → all zeros, no lines, margins null", async () => {
        const p = await computePnl(gCold, FROM, TO);
        expect(p.revenue).toEqual([]);
        expect(p.revenueTotal).toBe(0);
        expect(p.cogs).toBe(0);
        expect(p.grossProfit).toBe(0);
        expect(p.grossMarginPct).toBeNull();
        expect(p.expenses).toEqual([]);
        expect(p.expensesTotal).toBe(0);
        expect(p.netProfit).toBe(0);
        expect(p.netMarginPct).toBeNull();
        expect(p.coverage).toEqual({ invoicesTotal: 0, invoicesCosted: 0, cogsFlagOff: true });
    });

    it("Revenue only → gross profit = revenue, 100% margin", async () => {
        await seedLedger(gWarm, [
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "inv-1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "inv-1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "inv-1" },
        ]);
        const p = await computePnl(gWarm, FROM, TO);
        expect(p.revenueTotal).toBe(200);
        expect(p.cogs).toBe(0);
        expect(p.grossProfit).toBe(200);
        expect(p.grossMarginPct).toBe(100);
        expect(p.netProfit).toBe(200);
        expect(p.coverage).toEqual({ invoicesTotal: 1, invoicesCosted: 0, cogsFlagOff: false });
    });

    it("Revenue + matching COGS → gross profit = revenue − COGS, coverage 1/1", async () => {
        await seedLedger(gWarm, [
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "inv-1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "inv-1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "inv-1" },
            { account: ACCOUNTS.COGS, debit: 80, sourceType: "INVOICE_COGS", sourceId: "inv-1" },
            { account: ACCOUNTS.INVENTORY, credit: 80, sourceType: "INVOICE_COGS", sourceId: "inv-1" },
        ]);
        const p = await computePnl(gWarm, FROM, TO);
        expect(p.revenueTotal).toBe(200);
        expect(p.cogs).toBe(80);
        expect(p.grossProfit).toBe(120);
        expect(p.grossMarginPct).toBe(60);
        expect(p.coverage).toEqual({ invoicesTotal: 1, invoicesCosted: 1, cogsFlagOff: false });
    });

    it("Revenue with COGS flag OFF → cogsFlagOff=true so page can explain", async () => {
        await seedLedger(gCold, [
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "inv-1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "inv-1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "inv-1" },
        ]);
        const p = await computePnl(gCold, FROM, TO);
        expect(p.cogs).toBe(0);
        expect(p.grossProfit).toBe(200);
        expect(p.coverage.cogsFlagOff).toBe(true);
        expect(p.coverage.invoicesTotal).toBe(1);
        expect(p.coverage.invoicesCosted).toBe(0);
    });

    it("Expenses only → net = −expenses, gross = 0", async () => {
        await seedLedger(gWarm, [
            { account: ACCOUNTS.EXP_RENT, debit: 3000, sourceType: "EXPENSE", sourceId: "exp-1" },
            { account: ACCOUNTS.CASH, credit: 3000, sourceType: "EXPENSE", sourceId: "exp-1" },
            { account: ACCOUNTS.EXP_UTILITIES, debit: 450, sourceType: "EXPENSE", sourceId: "exp-2" },
            { account: ACCOUNTS.CASH, credit: 450, sourceType: "EXPENSE", sourceId: "exp-2" },
        ]);
        const p = await computePnl(gWarm, FROM, TO);
        expect(p.revenueTotal).toBe(0);
        expect(p.grossProfit).toBe(0);
        expect(p.expensesTotal).toBe(3450);
        expect(p.netProfit).toBe(-3450);
        expect(p.netMarginPct).toBeNull(); // no revenue → margin undefined
        // Only touched categories rendered
        expect(p.expenses.map((e) => e.account).sort()).toEqual(
            [ACCOUNTS.EXP_RENT, ACCOUNTS.EXP_UTILITIES].sort(),
        );
    });

    it("Zero-balance categories don't render as AED 0.00 lines", async () => {
        await seedLedger(gWarm, [
            { account: ACCOUNTS.EXP_RENT, debit: 3000, sourceType: "EXPENSE", sourceId: "exp-1" },
            { account: ACCOUNTS.CASH, credit: 3000, sourceType: "EXPENSE", sourceId: "exp-1" },
        ]);
        const p = await computePnl(gWarm, FROM, TO);
        // Only rent showed activity — the other 10 expense categories should be absent.
        expect(p.expenses).toHaveLength(1);
        expect(p.expenses[0].account).toBe(ACCOUNTS.EXP_RENT);
    });

    it("Half-open interval: [from, to) — rows at exactly `to` are excluded, at `from` included", async () => {
        await seedLedger(gWarm, [
            { account: ACCOUNTS.SALES, credit: 100, sourceType: "INVOICE", sourceId: "inv-boundary-from", at: FROM },
            { account: ACCOUNTS.AR, debit: 100, sourceType: "INVOICE", sourceId: "inv-boundary-from", at: FROM },
            { account: ACCOUNTS.SALES, credit: 999, sourceType: "INVOICE", sourceId: "inv-boundary-to", at: TO },
            { account: ACCOUNTS.AR, debit: 999, sourceType: "INVOICE", sourceId: "inv-boundary-to", at: TO },
        ]);
        const p = await computePnl(gWarm, FROM, TO);
        // Row at exactly `from` → included; row at exactly `to` → excluded.
        expect(p.revenueTotal).toBe(100);
    });
});
