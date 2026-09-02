/**
 * Accounting E1c — recordExpenseAction + voidExpenseAction.
 *
 * Six tests pin the direct-posting shape:
 *   1. HAPPY: record → Expense row created, DR expense-account +
 *      CR Cash pair, sums balanced.
 *   2. Void → status=VOID, reversing pair (DR Cash + CR expense-
 *      account) posted, net across both pairs = 0 in the ledger.
 *   3. Double-void refused.
 *   4. Category → account mapping correct across all 11 categories.
 *   5. Invalid category / amount / method refused with clear message.
 *   6. Supplier from another garage refused; expense not persisted.
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

const { recordExpenseAction, voidExpenseAction } = await import(
    "@/app/actions/expenses"
);

const P = "expenses-e1c-";
const gId = P + "garage";
const gOtherId = P + "other-garage";

function owner() {
    return { user: { id: P + "u", role: "OWNER", garageId: gId, email: "x", name: "x" } };
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

async function cleanup() {
    await prisma.ledgerEntry.deleteMany({ where: { garageId: { in: [gId, gOtherId] } } });
    // Expense is delete-guarded (E1b) — set the session flag before
    // the DELETE inside the same tx. SET LOCAL is per-tx.
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.allow_expense_delete = 'true'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "Expense" WHERE "garageId" IN ('${gId}', '${gOtherId}')`,
        );
    });
    await prisma.supplier.deleteMany({ where: { garageId: { in: [gId, gOtherId] } } });
    await prisma.garage.deleteMany({ where: { id: { in: [gId, gOtherId] } } });
}

beforeEach(async () => {
    await cleanup();
    await prisma.garage.create({ data: { id: gId, name: P + "G" } });
    await prisma.garage.create({ data: { id: gOtherId, name: P + "OtherG" } });
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("recordExpenseAction — E1c direct posting", { retry: 2 }, () => {
    it("HAPPY: record rent → Expense row + balanced DR/CR pair", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        await call(
            recordExpenseAction,
            form({
                category: "RENT",
                amount: "5000",
                method: "Bank Transfer",
                paidAt: "2026-09-01",
                note: "September rent",
            }),
        );
        const expenses = await prisma.expense.findMany({ where: { garageId: gId } });
        expect(expenses.length).toBe(1);
        const e = expenses[0];
        expect(e.category).toBe("RENT");
        // E1f — expense schema split: total (gross) + subtotal + vatAmount.
        // Legacy `amount` form input still accepted as backward-compat;
        // the DB stores it as total, with vatAmount defaulting to 0 (no
        // auto-calc — see rule 12 + recordExpenseAction).
        expect(Number(e.total)).toBe(5000);
        expect(Number(e.subtotal)).toBe(5000);
        expect(Number(e.vatAmount)).toBe(0);
        expect(e.method).toBe("Bank Transfer");
        expect(e.status).toBe("ACTIVE");
        expect(e.note).toBe("September rent");

        const entries = await prisma.ledgerEntry.findMany({
            where: { sourceType: "EXPENSE", sourceId: e.id },
            orderBy: { account: "asc" },
        });
        expect(entries.length).toBe(2);
        const dr = entries.reduce((s, r) => s + Number(r.debit), 0);
        const cr = entries.reduce((s, r) => s + Number(r.credit), 0);
        expect(dr).toBe(5000);
        expect(cr).toBe(5000);

        const byAccount = new Map(
            entries.map((r) => [r.account, { d: Number(r.debit), c: Number(r.credit) }]),
        );
        expect(byAccount.get(ACCOUNTS.EXP_RENT)).toEqual({ d: 5000, c: 0 });
        expect(byAccount.get(ACCOUNTS.CASH)).toEqual({ d: 0, c: 5000 });
    });

    it("category → account map covers all 11 categories with the right ledger account", async () => {
        const cases: Array<[string, string]> = [
            ["RENT", ACCOUNTS.EXP_RENT],
            ["SALARIES", ACCOUNTS.EXP_SALARIES],
            ["UTILITIES", ACCOUNTS.EXP_UTILITIES],
            ["TOOLS", ACCOUNTS.EXP_TOOLS],
            ["VEHICLE", ACCOUNTS.EXP_VEHICLE],
            ["MARKETING", ACCOUNTS.EXP_MARKETING],
            ["BANK_CHARGES", ACCOUNTS.EXP_BANK_CHARGES],
            ["OFFICE", ACCOUNTS.EXP_OFFICE],
            ["REPAIRS_MAINT", ACCOUNTS.EXP_REPAIRS_MAINT],
            ["PROF_FEES", ACCOUNTS.EXP_PROF_FEES],
            ["MISC", ACCOUNTS.EXP_MISC],
        ];
        for (const [cat, expectedAccount] of cases) {
            mockAuth.mockResolvedValueOnce(owner());
            await call(
                recordExpenseAction,
                form({ category: cat, amount: "10", method: "Cash" }),
            );
        }
        // 11 expenses, each with 2 ledger rows (DR expense-account + CR CASH).
        const expenses = await prisma.expense.findMany({
            where: { garageId: gId },
            orderBy: { createdAt: "asc" },
        });
        expect(expenses.length).toBe(11);
        for (let i = 0; i < cases.length; i++) {
            const [cat, expectedAccount] = cases[i];
            const entries = await prisma.ledgerEntry.findMany({
                where: { sourceType: "EXPENSE", sourceId: expenses[i].id },
                orderBy: { account: "asc" },
            });
            expect(expenses[i].category, `expense ${i}`).toBe(cat);
            const debitAccount = entries.find((r) => Number(r.debit) > 0)?.account;
            expect(debitAccount, `expense ${cat} debit account`).toBe(expectedAccount);
        }
    });

    it("Invalid category refused", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        const to = await call(
            recordExpenseAction,
            form({ category: "NOT_A_CATEGORY", amount: "10", method: "Cash" }),
        );
        expect(to).toContain("error=");
        expect(decodeURIComponent(to).toLowerCase()).toContain("invalid expense category");
        expect((await prisma.expense.findMany({ where: { garageId: gId } })).length).toBe(0);
    });

    it("Non-positive amount refused", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        const to = await call(
            recordExpenseAction,
            form({ category: "RENT", amount: "0", method: "Cash" }),
        );
        expect(to).toContain("error=");
        expect(decodeURIComponent(to).toLowerCase()).toContain("positive");
        expect((await prisma.expense.findMany({ where: { garageId: gId } })).length).toBe(0);
    });

    it("Cross-garage supplier refused", async () => {
        const otherSupplier = await prisma.supplier.create({
            data: { garageId: gOtherId, name: P + "other-supp" },
        });
        mockAuth.mockResolvedValueOnce(owner());
        const to = await call(
            recordExpenseAction,
            form({
                category: "REPAIRS_MAINT",
                amount: "300",
                method: "Cash",
                supplierId: otherSupplier.id,
            }),
        );
        expect(to).toContain("error=");
        expect(decodeURIComponent(to).toLowerCase()).toContain("supplier not found");
        expect((await prisma.expense.findMany({ where: { garageId: gId } })).length).toBe(0);
    });
});

describe("voidExpenseAction — reversing pair", { retry: 2 }, () => {
    it("HAPPY: void → status=VOID + reversing pair, net across ledger = 0", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        await call(
            recordExpenseAction,
            form({ category: "UTILITIES", amount: "250", method: "Cash" }),
        );
        const expense = (await prisma.expense.findFirst({ where: { garageId: gId } }))!;
        mockAuth.mockResolvedValueOnce(owner());
        await call(voidExpenseAction, form({ expenseId: expense.id }));

        const updated = await prisma.expense.findUnique({ where: { id: expense.id } });
        expect(updated?.status).toBe("VOID");

        // 4 rows total for this expense — 2 from record, 2 from void.
        const entries = await prisma.ledgerEntry.findMany({
            where: { sourceType: "EXPENSE", sourceId: expense.id },
        });
        expect(entries.length).toBe(4);
        // Net per account across all 4 rows should be zero (record cancels void).
        const netByAccount = new Map<string, number>();
        for (const e of entries) {
            const net = Number(e.debit) - Number(e.credit);
            netByAccount.set(e.account, (netByAccount.get(e.account) ?? 0) + net);
        }
        expect(netByAccount.get(ACCOUNTS.EXP_UTILITIES)).toBe(0);
        expect(netByAccount.get(ACCOUNTS.CASH)).toBe(0);
    });

    it("Double-void refused, second call leaves state unchanged", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        await call(
            recordExpenseAction,
            form({ category: "OFFICE", amount: "40", method: "Cash" }),
        );
        const expense = (await prisma.expense.findFirst({ where: { garageId: gId } }))!;
        mockAuth.mockResolvedValueOnce(owner());
        await call(voidExpenseAction, form({ expenseId: expense.id }));
        mockAuth.mockResolvedValueOnce(owner());
        const to = await call(voidExpenseAction, form({ expenseId: expense.id }));
        expect(to).toContain("error=");
        expect(decodeURIComponent(to).toLowerCase()).toContain("already void");
        // Still exactly 4 rows — the second void didn't add another pair.
        const entries = await prisma.ledgerEntry.findMany({
            where: { sourceType: "EXPENSE", sourceId: expense.id },
        });
        expect(entries.length).toBe(4);
    });
});

describe("recordExpenseAction — E1f VAT split", () => {
    it("Non-zero VAT → 3-row ledger (DR expense subtotal + DR VAT_INPUT vat / CR Cash total), balanced", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        await call(
            recordExpenseAction,
            form({
                category: "RENT",
                total: "1050",
                vatAmount: "50",
                method: "Bank Transfer",
                paidAt: "2026-09-15",
                note: "Office rent inc. 5% VAT",
            }),
        );
        const [e] = await prisma.expense.findMany({ where: { garageId: gId } });
        expect(Number(e.total)).toBe(1050);
        expect(Number(e.subtotal)).toBe(1000);
        expect(Number(e.vatAmount)).toBe(50);

        const rows = await prisma.ledgerEntry.findMany({
            where: { sourceType: "EXPENSE", sourceId: e.id },
            orderBy: { account: "asc" },
        });
        expect(rows.length).toBe(3);
        const dr = rows.reduce((s, r) => s + Number(r.debit), 0);
        const cr = rows.reduce((s, r) => s + Number(r.credit), 0);
        expect(dr).toBe(1050);
        expect(cr).toBe(1050);
        const byAcc = new Map(rows.map((r) => [r.account, { d: Number(r.debit), c: Number(r.credit) }]));
        expect(byAcc.get(ACCOUNTS.EXP_RENT)).toEqual({ d: 1000, c: 0 });
        expect(byAcc.get(ACCOUNTS.VAT_INPUT)).toEqual({ d: 50, c: 0 });
        expect(byAcc.get(ACCOUNTS.CASH)).toEqual({ d: 0, c: 1050 });
    });

    it("Zero VAT (or omitted) → 2-row ledger, pre-E1f shape preserved", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        await call(
            recordExpenseAction,
            form({
                category: "SALARIES",
                total: "5000",
                // vatAmount omitted → defaults to 0
                method: "Cash",
                paidAt: "2026-09-15",
            }),
        );
        const [e] = await prisma.expense.findMany({ where: { garageId: gId } });
        expect(Number(e.vatAmount)).toBe(0);
        const rows = await prisma.ledgerEntry.findMany({
            where: { sourceType: "EXPENSE", sourceId: e.id },
        });
        // No VAT row when vatAmount = 0 — same 2-row shape as pre-E1f.
        expect(rows.length).toBe(2);
        const accounts = rows.map((r) => r.account).sort();
        expect(accounts).toEqual([ACCOUNTS.CASH, ACCOUNTS.EXP_SALARIES].sort());
    });

    it("vatAmount > total refused with clear message; nothing persisted", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        const to = await call(
            recordExpenseAction,
            form({
                category: "UTILITIES",
                total: "100",
                vatAmount: "500",
                method: "Cash",
            }),
        );
        expect(decodeURIComponent(to).toLowerCase()).toContain("vat amount");
        expect(decodeURIComponent(to).toLowerCase()).toContain("more than the total");
        expect(await prisma.expense.count({ where: { garageId: gId } })).toBe(0);
        expect(
            await prisma.ledgerEntry.count({ where: { garageId: gId, sourceType: "EXPENSE" } }),
        ).toBe(0);
    });

    it("Void with VAT → 3 reversing rows posted, net across all 6 rows = 0 per account", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        await call(
            recordExpenseAction,
            form({
                category: "TOOLS",
                total: "210",
                vatAmount: "10",
                method: "Card",
                paidAt: "2026-09-15",
            }),
        );
        const [e] = await prisma.expense.findMany({ where: { garageId: gId } });
        mockAuth.mockResolvedValueOnce(owner());
        await call(voidExpenseAction, form({ expenseId: e.id }));

        const rows = await prisma.ledgerEntry.findMany({
            where: { sourceType: "EXPENSE", sourceId: e.id },
        });
        expect(rows.length).toBe(6); // 3 record + 3 reverse
        const netByAccount = new Map<string, number>();
        for (const r of rows) {
            const net = Number(r.debit) - Number(r.credit);
            netByAccount.set(r.account, (netByAccount.get(r.account) ?? 0) + net);
        }
        expect(netByAccount.get(ACCOUNTS.EXP_TOOLS)).toBe(0);
        expect(netByAccount.get(ACCOUNTS.VAT_INPUT)).toBe(0);
        expect(netByAccount.get(ACCOUNTS.CASH)).toBe(0);
    });

    it("Void without VAT (flag was zero) → 2 reversing rows only, no stray VAT_INPUT reversal", async () => {
        mockAuth.mockResolvedValueOnce(owner());
        await call(
            recordExpenseAction,
            form({
                category: "MISC",
                total: "40",
                // no vatAmount
                method: "Cash",
            }),
        );
        const [e] = await prisma.expense.findMany({ where: { garageId: gId } });
        mockAuth.mockResolvedValueOnce(owner());
        await call(voidExpenseAction, form({ expenseId: e.id }));

        const rows = await prisma.ledgerEntry.findMany({
            where: { sourceType: "EXPENSE", sourceId: e.id },
        });
        expect(rows.length).toBe(4); // 2 record + 2 reverse
        const vatRows = rows.filter((r) => r.account === ACCOUNTS.VAT_INPUT);
        expect(vatRows.length).toBe(0);
    });
});
