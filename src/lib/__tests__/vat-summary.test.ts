/**
 * E4 — VAT summary computation. AR 2026-09-02.
 *
 * Pins the ledger-reading + coverage-counting behaviour:
 *   1. Zero-activity garage → all zeros, coverage zero, no NaN.
 *   2. Output VAT only (invoice, no expense/bill) → outputVat positive,
 *      inputVat zero, net = outputVat (owed to FTA).
 *   3. Input VAT only (expense with VAT) → inputVat positive,
 *      outputVat zero, net = -inputVat (refund due).
 *   4. Mixed → net = output - input (typical quarterly shape).
 *   5. Coverage counts ACTIVE expenses / non-VOID bills in the
 *      period, and splits by "has VAT" vs "zero VAT". Voided expense
 *      excluded from the coverage denominator.
 *   6. Void-and-reissue pattern nets to zero for the invoice in the
 *      ledger — outputVat reflects reversal, not double-count.
 *   7. Half-open interval [from, to) matches rule 13.
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
        await tx.$executeRawUnsafe(`SET LOCAL app.allow_expense_delete = 'true'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "Expense" WHERE "garageId" LIKE '${P}%'`,
        );
    });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}
beforeEach(async () => {
    await cleanup();
    await prisma.garage.create({ data: { id: gId, name: gId } });
});
afterAll(cleanup);

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-10-01T00:00:00.000Z");
const IN_Q = new Date("2026-08-15T12:00:00.000Z");

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

async function seedExpense(
    opts: { total: number; vat: number; paidAt?: Date; status?: "ACTIVE" | "VOID" },
) {
    return prisma.expense.create({
        data: {
            garageId: gId,
            category: "RENT",
            total: opts.total,
            subtotal: opts.total - opts.vat,
            vatAmount: opts.vat,
            paidAt: opts.paidAt ?? IN_Q,
            method: "Cash",
            status: opts.status ?? "ACTIVE",
        },
    });
}

describe("computeVatSummary", () => {
    it("Zero activity → all zeros, coverage zero", async () => {
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.outputVat).toBe(0);
        expect(v.inputVat).toBe(0);
        expect(v.netPayable).toBe(0);
        expect(v.coverage).toEqual({
            expensesTotal: 0,
            expensesWithVat: 0,
            supplierBillsTotal: 0,
            supplierBillsWithVat: 0,
        });
    });

    it("Output VAT only → payable positive, net = output", async () => {
        await ledger([
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i1" },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.outputVat).toBe(10);
        expect(v.inputVat).toBe(0);
        expect(v.netPayable).toBe(10);
    });

    it("Input VAT only → inputVat positive, net = negative (refund due)", async () => {
        await ledger([
            { account: ACCOUNTS.EXP_RENT, debit: 100, sourceType: "EXPENSE", sourceId: "e1" },
            { account: ACCOUNTS.VAT_INPUT, debit: 5, sourceType: "EXPENSE", sourceId: "e1" },
            { account: ACCOUNTS.CASH, credit: 105, sourceType: "EXPENSE", sourceId: "e1" },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.outputVat).toBe(0);
        expect(v.inputVat).toBe(5);
        expect(v.netPayable).toBe(-5);
    });

    it("Mixed output + input → net = output - input", async () => {
        await ledger([
            // Invoice: 200 net + 10 VAT collected
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i1" },
            // Expense: 100 net + 5 VAT paid
            { account: ACCOUNTS.EXP_RENT, debit: 100, sourceType: "EXPENSE", sourceId: "e1" },
            { account: ACCOUNTS.VAT_INPUT, debit: 5, sourceType: "EXPENSE", sourceId: "e1" },
            { account: ACCOUNTS.CASH, credit: 105, sourceType: "EXPENSE", sourceId: "e1" },
            // Supplier bill: 1000 net + 50 VAT paid
            { account: ACCOUNTS.INVENTORY, debit: 1000, sourceType: "SUPPLIER_BILL", sourceId: "b1" },
            { account: ACCOUNTS.VAT_INPUT, debit: 50, sourceType: "SUPPLIER_BILL", sourceId: "b1" },
            { account: ACCOUNTS.AP, credit: 1050, sourceType: "SUPPLIER_BILL", sourceId: "b1" },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.outputVat).toBe(10);
        expect(v.inputVat).toBe(55); // 5 + 50
        expect(v.netPayable).toBe(-45);
    });

    it("Coverage: ACTIVE expenses with VAT split; voided expenses excluded", async () => {
        await seedExpense({ total: 100, vat: 5 });
        await seedExpense({ total: 200, vat: 0 });
        await seedExpense({ total: 300, vat: 15 });
        await seedExpense({ total: 400, vat: 20, status: "VOID" });
        const v = await computeVatSummary(gId, FROM, TO);
        expect(v.coverage.expensesTotal).toBe(3);
        expect(v.coverage.expensesWithVat).toBe(2);
    });

    it("Void-and-reissue: reversing INVOICE_VOID nets outputVat cleanly", async () => {
        await ledger([
            // Original invoice
            { account: ACCOUNTS.AR, debit: 210, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.SALES, credit: 200, sourceType: "INVOICE", sourceId: "i1" },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 10, sourceType: "INVOICE", sourceId: "i1" },
            // Void reversal — same sourceId, different sourceType
            { account: ACCOUNTS.AR, credit: 210, sourceType: "INVOICE_VOID", sourceId: "i1" },
            { account: ACCOUNTS.SALES, debit: 200, sourceType: "INVOICE_VOID", sourceId: "i1" },
            { account: ACCOUNTS.VAT_PAYABLE, debit: 10, sourceType: "INVOICE_VOID", sourceId: "i1" },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        // Original 10 collected, reversal debits 10 back — net zero.
        expect(v.outputVat).toBe(0);
        expect(v.netPayable).toBe(0);
    });

    it("Half-open interval [from, to): row at exactly `to` excluded", async () => {
        await ledger([
            { account: ACCOUNTS.VAT_PAYABLE, credit: 100, sourceType: "INVOICE", sourceId: "in-quarter", at: IN_Q },
            { account: ACCOUNTS.VAT_PAYABLE, credit: 999, sourceType: "INVOICE", sourceId: "at-boundary", at: TO },
        ]);
        const v = await computeVatSummary(gId, FROM, TO);
        // Row at exactly `to` excluded, in-quarter row included.
        expect(v.outputVat).toBe(100);
    });
});
