/**
 * VAT summary (E4, AR 2026-09-02).
 *
 * Reads the ledger — no aggregation over Invoice / Expense / SupplierBill.
 * Same rule as the P&L (rule 13): the ledger is the single source of
 * truth, a report that ignores it is a report that will disagree with
 * the auditor's export.
 *
 * Output for a date range (typically a UAE VAT quarter):
 *
 *   Output VAT       — collected from invoices (VAT_PAYABLE balance,
 *                      CR-normal, flipped for display)
 *   Input VAT        — paid on purchases + expenses (VAT_INPUT balance,
 *                      DR-normal)
 *   Net VAT payable  — outputVat − inputVat
 *                      positive = owe FTA; negative = refund due
 *
 * Coverage (rule 12 discipline — surface the gap, don't fake it):
 *   expensesTotal / expensesWithVat — how many ACTIVE Expense rows
 *     in the period carry a non-zero VAT amount versus zero. A period
 *     where every expense reads zero probably means nobody entered
 *     any VAT — the reclaim is under-reported.
 *   supplierBillsTotal / supplierBillsWithVat — same shape for
 *     supplier bills, informational (Payables C3 already enforces
 *     capture at receive-form time, so gaps here are rare and only
 *     appear when a shop deliberately received a zero-VAT bill).
 *
 * We produce the figures — the return itself is filed on the FTA
 * portal. Copy on the page must not imply otherwise.
 */

import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";

export interface VatCoverage {
    expensesTotal: number;
    expensesWithVat: number;
    supplierBillsTotal: number;
    supplierBillsWithVat: number;
}

export interface VatSummaryResult {
    fromDate: Date;
    toDate: Date;
    outputVat: number;
    inputVat: number;
    netPayable: number;
    coverage: VatCoverage;
}

/** Sum DR − CR across matching rows. Positive = debit-normal balance. */
function balance(rows: { debit: unknown; credit: unknown }[]): number {
    let sum = 0;
    for (const r of rows) sum += Number(r.debit) - Number(r.credit);
    return Math.round(sum * 100) / 100;
}

/**
 * Compute the VAT summary for one garage across the half-open
 * interval [fromDate, toDate). Same date shape as the P&L helper.
 */
export async function computeVatSummary(
    garageId: string,
    fromDate: Date,
    toDate: Date,
): Promise<VatSummaryResult> {
    const [vatRows, expensesTotal, expensesWithVat, supplierBillsTotal, supplierBillsWithVat] =
        await Promise.all([
            prisma.ledgerEntry.findMany({
                where: {
                    garageId,
                    createdAt: { gte: fromDate, lt: toDate },
                    account: { in: [ACCOUNTS.VAT_PAYABLE, ACCOUNTS.VAT_INPUT] },
                },
                select: { account: true, debit: true, credit: true },
            }),
            prisma.expense.count({
                where: {
                    garageId,
                    status: "ACTIVE",
                    paidAt: { gte: fromDate, lt: toDate },
                },
            }),
            prisma.expense.count({
                where: {
                    garageId,
                    status: "ACTIVE",
                    paidAt: { gte: fromDate, lt: toDate },
                    vatAmount: { gt: 0 },
                },
            }),
            prisma.supplierBill.count({
                where: {
                    garageId,
                    status: { not: "VOID" },
                    billDate: { gte: fromDate, lt: toDate },
                },
            }),
            prisma.supplierBill.count({
                where: {
                    garageId,
                    status: { not: "VOID" },
                    billDate: { gte: fromDate, lt: toDate },
                    vatAmount: { gt: 0 },
                },
            }),
        ]);

    const payableRows = vatRows.filter((r) => r.account === ACCOUNTS.VAT_PAYABLE);
    const inputRows = vatRows.filter((r) => r.account === ACCOUNTS.VAT_INPUT);

    // VAT_PAYABLE is CR-normal — output VAT owed to FTA increases the
    // credit side. Flip sign so the display shows a positive collected
    // number instead of a negative debit-normal balance.
    const outputVat = -balance(payableRows);
    // VAT_INPUT is DR-normal — reclaimable input tax already carries
    // the correct sign as a debit balance.
    const inputVat = balance(inputRows);
    const netPayable = Math.round((outputVat - inputVat) * 100) / 100;

    return {
        fromDate,
        toDate,
        outputVat,
        inputVat,
        netPayable,
        coverage: {
            expensesTotal,
            expensesWithVat,
            supplierBillsTotal,
            supplierBillsWithVat,
        },
    };
}
