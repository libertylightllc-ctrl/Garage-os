/**
 * P&L computation (E3, AR 2026-09-02).
 *
 * Reads directly from LedgerEntry — the honest single source of truth
 * that the C4a COGS-at-invoice post and the E1c expense-recording post
 * both land in. NO reads from Invoice / Expense / Part.cost surfaces:
 * the whole point of full-accrual bookkeeping is that P&L trusts the
 * ledger, and if the ledger is wrong the fix is in the writer, not in
 * a divergent report.
 *
 * Structure:
 *
 *   Revenue
 *     Sales Revenue                     +CR - DR balance of SALES
 *   Cost of Goods Sold                  +DR - CR balance of COGS
 *   ────────────────────────────
 *   Gross Profit                        Revenue − COGS
 *
 *   Operating Expenses (by category)
 *     Rent                              +DR - CR balance of EXP_RENT
 *     Salaries & Wages                  ...
 *     ...
 *   ────────────────────────────
 *   Net Profit                          Gross Profit − Total Expenses
 *
 * Coverage banner data (invoicesTotal / invoicesCosted for the period)
 * lets the page tell the operator whether COGS is missing for legit
 * reasons (pre-C4a invoices, cogsEnabled off, null unitCost) vs
 * silently. Same "surface the gap, don't fake it" discipline as rule 12
 * on VAT-on-expenses.
 *
 * Labour is NOT COGS. LABOR / FEE / DISCOUNT invoice lines contribute
 * to Sales Revenue (no separate revenue account) and their P&L
 * counterpart is technician salary — recorded as an EXP_SALARIES row
 * on the expense side. Rule 10 (updated 2026-09-02) has the reasoning:
 * booking labour revenue against a labour-COGS row double-counts
 * technician wages.
 */

import { prisma } from "@/lib/prisma";
import { ACCOUNTS, ACCOUNT_TYPES } from "@/lib/billing";

export interface PnlLine {
    account: string;
    amount: number;
}

export interface PnlCoverage {
    /** Distinct SENT/PAID invoices with any LedgerEntry sourceType='INVOICE' inside the period. */
    invoicesTotal: number;
    /** Subset of invoicesTotal that ALSO have a matching sourceType='INVOICE_COGS' row. */
    invoicesCosted: number;
    /** True when cogsEnabled is off — the whole-garage explanation
     *  for a zero COGS figure so the page can say "flag is off"
     *  rather than the misleading "no invoices had cost data". */
    cogsFlagOff: boolean;
}

export interface PnlResult {
    fromDate: Date;
    toDate: Date;
    revenue: PnlLine[];
    revenueTotal: number;
    cogs: number;
    grossProfit: number;
    grossMarginPct: number | null;
    expenses: PnlLine[];
    expensesTotal: number;
    netProfit: number;
    netMarginPct: number | null;
    coverage: PnlCoverage;
}

/** Sum DR − CR across matching rows. Positive = debit-normal balance. */
function balance(rows: { debit: unknown; credit: unknown }[]): number {
    let sum = 0;
    for (const r of rows) sum += Number(r.debit) - Number(r.credit);
    return Math.round(sum * 100) / 100;
}

/** Every EXPENSE-typed account, ordered as declared in ACCOUNTS. */
const EXPENSE_ACCOUNTS: string[] = Object.values(ACCOUNTS).filter(
    (a) => ACCOUNT_TYPES[a] === "EXPENSE" && a !== ACCOUNTS.COGS,
);

const REVENUE_ACCOUNTS: string[] = Object.values(ACCOUNTS).filter(
    (a) => ACCOUNT_TYPES[a] === "REVENUE",
);

/**
 * Read the ledger for one garage across the half-open interval
 * [fromDate, toDate). Callers pass real Dates already normalized to
 * garage-local day boundaries (the page constructs them from the
 * date-range form; the helper doesn't infer a timezone).
 */
export async function computePnl(
    garageId: string,
    fromDate: Date,
    toDate: Date,
): Promise<PnlResult> {
    // Batched: one findMany per account category rather than one per
    // account, so we don't fan out to 13 round-trips. Prisma groupBy
    // would work too but the caller-side sum lets us reuse `balance()`.
    const [ledgerRows, garage, invoicesInPeriod, cogsRows] = await Promise.all([
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                createdAt: { gte: fromDate, lt: toDate },
                account: { in: [...REVENUE_ACCOUNTS, ACCOUNTS.COGS, ...EXPENSE_ACCOUNTS] },
            },
            select: { account: true, debit: true, credit: true },
        }),
        prisma.garage.findUniqueOrThrow({
            where: { id: garageId },
            select: { cogsEnabled: true },
        }),
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                sourceType: "INVOICE",
                createdAt: { gte: fromDate, lt: toDate },
            },
            select: { sourceId: true },
            distinct: ["sourceId"],
        }),
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                sourceType: "INVOICE_COGS",
                createdAt: { gte: fromDate, lt: toDate },
            },
            select: { sourceId: true },
            distinct: ["sourceId"],
        }),
    ]);

    // Bucket rows by account for balance().
    const byAccount = new Map<string, { debit: unknown; credit: unknown }[]>();
    for (const r of ledgerRows) {
        const arr = byAccount.get(r.account) ?? [];
        arr.push(r);
        byAccount.set(r.account, arr);
    }

    // Revenue is CR-normal, so the P&L "amount" flips sign.
    const revenue: PnlLine[] = REVENUE_ACCOUNTS.map((a) => ({
        account: a,
        amount: -balance(byAccount.get(a) ?? []),
    })).filter((l) => l.amount !== 0);
    const revenueTotal = round2(revenue.reduce((s, l) => s + l.amount, 0));

    // COGS is DR-normal.
    const cogs = balance(byAccount.get(ACCOUNTS.COGS) ?? []);
    const grossProfit = round2(revenueTotal - cogs);
    const grossMarginPct = revenueTotal > 0 ? round2((grossProfit / revenueTotal) * 100) : null;

    // Expenses: DR-normal, drop zero-balance categories so the page
    // doesn't list 11 lines when the shop only paid rent.
    const expenses: PnlLine[] = EXPENSE_ACCOUNTS.map((a) => ({
        account: a,
        amount: balance(byAccount.get(a) ?? []),
    })).filter((l) => l.amount !== 0);
    const expensesTotal = round2(expenses.reduce((s, l) => s + l.amount, 0));

    const netProfit = round2(grossProfit - expensesTotal);
    const netMarginPct = revenueTotal > 0 ? round2((netProfit / revenueTotal) * 100) : null;

    const invoicedSet = new Set(invoicesInPeriod.map((r) => r.sourceId));
    const costedSet = new Set(cogsRows.map((r) => r.sourceId));
    const invoicesCosted = [...costedSet].filter((id) => invoicedSet.has(id)).length;

    return {
        fromDate,
        toDate,
        revenue,
        revenueTotal,
        cogs,
        grossProfit,
        grossMarginPct,
        expenses,
        expensesTotal,
        netProfit,
        netMarginPct,
        coverage: {
            invoicesTotal: invoicedSet.size,
            invoicesCosted,
            cogsFlagOff: !garage.cogsEnabled,
        },
    };
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
