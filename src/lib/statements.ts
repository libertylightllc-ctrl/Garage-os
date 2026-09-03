/**
 * Trial balance + balance sheet (E5, AR 2026-09-03).
 *
 * Both statements read LedgerEntry directly — rule 13/14/15 discipline.
 *
 * TRIAL BALANCE
 * Every account with any activity, columns DR + CR, sums at bottom.
 * Sum(DR) must equal Sum(CR) — that's the ledger's own consistency
 * check. If they don't, we render the difference explicitly rather
 * than hiding it: an imbalanced trial balance is telling you
 * something real about the data.
 *
 * BALANCE SHEET
 * Assets + Liabilities from their typed accounts. Equity as a
 * DERIVED figure:
 *   Accumulated profit (all time) = Revenue − (COGS + Expenses)
 * Labeled explicitly as "Accumulated profit (all time, derived)" —
 * no closing entries are posted to a Retained Earnings account.
 * Consequence per AR 2026-09-03: shop that discovers a missing
 * invoice later can just record it and every derived figure moves;
 * a period-close would have to be reversed or amended, which is
 * exactly the kind of thing rule 14 refuses to invite.
 *
 * COVERAGE (inherits every gap the P&L has)
 * Retained earnings derives from Revenue − COGS − Expenses. So the
 * balance sheet's equity line overstates for the same reason the
 * P&L's profit line overstates: uncosted invoices (COGS flag off,
 * pre-cutover, null unitCost) contribute revenue with no matching
 * cost. Same coverage banner shape — cumulative across all time,
 * not period-scoped like the P&L.
 *
 * IMBALANCE HANDLING
 * If Assets ≠ Liabilities + Equity, we show the delta as "Out of
 * balance by AED X.XX" — not a hidden plug. Every writer we ship
 * posts balanced ledger pairs, so the only way to see a non-zero
 * delta is data corruption or a writer bug. Making it visible is
 * how it gets caught.
 */

import { prisma } from "@/lib/prisma";
import { ACCOUNTS, ACCOUNT_TYPES, type AccountType } from "@/lib/billing";

export interface AccountBalanceRow {
    account: string;
    type: AccountType;
    debit: number;
    credit: number;
    /** Signed balance in the account's natural direction: positive = DR-normal balance for asset/expense/COGS, positive = CR-normal balance for liability/equity/revenue. */
    balance: number;
}

export interface StatementsCoverage {
    cogsFlagOff: boolean;
    /** All-time count of SENT/PAID/DELIVERED invoices — the denominator for coverage. */
    invoicesTotal: number;
    /** Subset of invoicesTotal that carry an INVOICE_COGS ledger pair. */
    invoicesCosted: number;
}

export interface StatementsResult {
    asOf: Date;
    /** Every account with any activity, in a stable order for display. */
    rows: AccountBalanceRow[];
    totalDebits: number;
    totalCredits: number;
    /** Sum of ASSET balances (DR − CR across all ASSET-typed accounts). */
    assets: number;
    /** Sum of LIABILITY balances (CR − DR across all LIABILITY-typed accounts). */
    liabilities: number;
    /** DERIVED accumulated profit = Revenue − COGS − Expenses. No closing entries posted. */
    accumulatedProfit: number;
    /** Balance-sheet equation check: assets − (liabilities + accumulatedProfit). Zero when the ledger is consistent (which it always is unless a writer has a bug). */
    outOfBalanceBy: number;
    coverage: StatementsCoverage;
}

function balance(rows: { debit: unknown; credit: unknown }[]): number {
    let sum = 0;
    for (const r of rows) sum += Number(r.debit) - Number(r.credit);
    return Math.round(sum * 100) / 100;
}
function normZero(n: number): number {
    return n + 0;
}
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

const ACCOUNT_DISPLAY_ORDER: AccountType[] = [
    "ASSET",
    "LIABILITY",
    "EQUITY",
    "REVENUE",
    "EXPENSE",
];

export async function computeStatements(
    garageId: string,
    asOf: Date,
): Promise<StatementsResult> {
    // One ledger read, all time up to asOf. Group in-memory by
    // account. Cheaper than N groupBy queries and lets us reuse
    // the same rows for both statements.
    const [ledgerRows, garage, invoicesTotal, invoicesCosted] = await Promise.all([
        prisma.ledgerEntry.findMany({
            where: { garageId, createdAt: { lt: asOf } },
            select: { account: true, debit: true, credit: true },
        }),
        prisma.garage.findUniqueOrThrow({
            where: { id: garageId },
            select: { cogsEnabled: true },
        }),
        prisma.invoice.count({
            where: {
                garageId,
                status: { not: "DRAFT" },
                issuedAt: { lt: asOf },
            },
        }),
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                sourceType: "INVOICE_COGS",
                createdAt: { lt: asOf },
            },
            select: { sourceId: true },
            distinct: ["sourceId"],
        }),
    ]);

    // Bucket rows by account. Track total DR + total CR (for trial
    // balance's two columns) and net balance (for balance sheet
    // arithmetic).
    const byAccount = new Map<string, { debit: number; credit: number; type: AccountType }>();
    for (const r of ledgerRows) {
        const type = ACCOUNT_TYPES[r.account];
        if (!type) continue; // unknown account — skip rather than crash
        const cur = byAccount.get(r.account) ?? { debit: 0, credit: 0, type };
        cur.debit += Number(r.debit);
        cur.credit += Number(r.credit);
        byAccount.set(r.account, cur);
    }

    // Emit rows in a stable order: type group, then declared
    // ACCOUNTS order within each group (matches ACCOUNTS registry
    // insertion order which is the accountant-readable sequence:
    // AR/Cash/Inventory/VAT-input, AP/VAT-payable/Deposits, ...).
    const declaredOrder: string[] = Object.values(ACCOUNTS);
    const rows: AccountBalanceRow[] = [];
    for (const type of ACCOUNT_DISPLAY_ORDER) {
        for (const acc of declaredOrder) {
            if (ACCOUNT_TYPES[acc] !== type) continue;
            const b = byAccount.get(acc);
            if (!b) continue;
            const dr = round2(b.debit);
            const cr = round2(b.credit);
            if (dr === 0 && cr === 0) continue;
            const isDrNormal = type === "ASSET" || type === "EXPENSE";
            const rawBalance = dr - cr;
            const balSigned = isDrNormal ? rawBalance : -rawBalance;
            rows.push({
                account: acc,
                type,
                debit: normZero(dr),
                credit: normZero(cr),
                balance: normZero(round2(balSigned)),
            });
        }
    }

    const totalDebits = normZero(round2(ledgerRows.reduce((s, r) => s + Number(r.debit), 0)));
    const totalCredits = normZero(round2(ledgerRows.reduce((s, r) => s + Number(r.credit), 0)));

    // Balance sheet arithmetic. Each type reads its own accounts.
    let assets = 0;
    let liabilities = 0;
    let revenue = 0;
    let cogs = 0;
    let expenses = 0;
    for (const [acc, v] of byAccount) {
        const drCr = v.debit - v.credit;
        switch (v.type) {
            case "ASSET":
                assets += drCr;
                break;
            case "LIABILITY":
                liabilities += -drCr;
                break;
            case "REVENUE":
                revenue += -drCr;
                break;
            case "EXPENSE":
                if (acc === ACCOUNTS.COGS) cogs += drCr;
                else expenses += drCr;
                break;
            case "EQUITY":
                // Not yet used — no writers touch EQUITY-typed
                // accounts. Reserved for a future OPENING_BALANCE_EQUITY
                // or RETAINED_EARNINGS constant. See rule 16.
                break;
        }
    }

    const accumulatedProfit = normZero(round2(revenue - cogs - expenses));
    const totalEquity = accumulatedProfit; // no other equity accounts today
    const totalLiabilitiesAndEquity = round2(liabilities + totalEquity);
    const outOfBalanceBy = normZero(round2(round2(assets) - totalLiabilitiesAndEquity));

    return {
        asOf,
        rows,
        totalDebits,
        totalCredits,
        assets: normZero(round2(assets)),
        liabilities: normZero(round2(liabilities)),
        accumulatedProfit,
        outOfBalanceBy,
        coverage: {
            cogsFlagOff: !garage.cogsEnabled,
            invoicesTotal,
            invoicesCosted: invoicesCosted.length,
        },
    };
}
