/**
 * VAT summary (E4 + E4b, AR 2026-09-02 / 2026-09-03).
 *
 * Reads the ledger — no aggregation over Invoice / Expense /
 * SupplierBill for the money numbers. Same rule 13/14 discipline.
 *
 * Output for a date range (typically a UAE VAT quarter):
 *
 *   Standard-rated supplies (per emirate)
 *     — VAT_PAYABLE from INVOICE rows whose Invoice.emirate is E
 *       AND Invoice.createdAt falls INSIDE the period.
 *
 *   Adjustments (per emirate) — E4b addition, AR 2026-09-03
 *     — VAT_PAYABLE from INVOICE_VOID rows whose ORIGINAL
 *       Invoice.emirate is E AND Invoice.createdAt falls OUTSIDE
 *       the period (i.e. the void reverses a prior-quarter sale).
 *       Same-quarter voids stay in the Standard column (they net
 *       against the original sale within the same period).
 *
 *   Input VAT (single total, no per-emirate split)
 *     — VAT_INPUT balance across all sourceTypes. Form 201 treats
 *       input VAT at entity level, not per-emirate — a shop's
 *       reclaim doesn't care which emirate the parts were bought
 *       for. Same treatment for EXPENSE (rent, utilities, etc).
 *
 *   Net VAT payable
 *     — sum of per-emirate (standard + adjustment) minus inputVat.
 *
 * Coverage (rule 12 + 14 discipline — surface the gap, don't fake it):
 *   expensesTotal / expensesWithVat — how many ACTIVE Expense rows
 *     in the period carry a non-zero VAT amount.
 *   supplierBillsTotal / supplierBillsWithVat — informational only.
 *   invoicesInPeriod / invoicesWithEmirate — how many invoices in
 *     the period carry an Invoice.emirate snapshot. Any gap here
 *     means the Standard-rated total includes an "unassigned" box
 *     that no accountant can post to Form 201.
 *
 * We produce the figures — the return itself is filed on the FTA
 * portal. Copy on the page must not imply otherwise.
 */

import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";
import { Emirate } from "@/generated/prisma/client";

const UNASSIGNED = "Unassigned" as const;
type EmirateBucket = Emirate | typeof UNASSIGNED;

export interface EmirateRow {
    /** Emirate enum value, or the string "Unassigned" for null-emirate rows. */
    emirate: EmirateBucket;
    /** VAT on invoices raised IN the period, per emirate. */
    standardVat: number;
    /** VAT on voids reversing prior-period invoices, per the original invoice's emirate. Positive means reduces payable. */
    adjustmentVat: number;
    /** standardVat − adjustmentVat. Positive = additional VAT owed for this emirate. */
    netVat: number;
}

export interface VatCoverage {
    expensesTotal: number;
    expensesWithVat: number;
    supplierBillsTotal: number;
    supplierBillsWithVat: number;
    invoicesInPeriod: number;
    invoicesWithEmirate: number;
}

export interface VatSummaryResult {
    fromDate: Date;
    toDate: Date;
    /** Per-emirate rows in Form 201 order + an "Unassigned" row when null-emirate invoices touched the period. */
    byEmirate: EmirateRow[];
    /** Sum of every emirate's standardVat. Positive. */
    outputVat: number;
    /** Sum of every emirate's adjustmentVat. Positive means the adjustments overall reduce output. */
    adjustmentsVat: number;
    /** VAT_INPUT balance across the period. Single entity-level number. */
    inputVat: number;
    /** outputVat − adjustmentsVat − inputVat. Positive = owe FTA; negative = refund due. */
    netPayable: number;
    coverage: VatCoverage;
}

/** Sum DR − CR across matching rows. Positive = debit-normal balance. */
function balance(rows: { debit: unknown; credit: unknown }[]): number {
    let sum = 0;
    for (const r of rows) sum += Number(r.debit) - Number(r.credit);
    return Math.round(sum * 100) / 100;
}

/** Coerce -0 → +0 so vitest .toBe(0) doesn't trip. */
function normZero(n: number): number {
    return n + 0;
}

export async function computeVatSummary(
    garageId: string,
    fromDate: Date,
    toDate: Date,
): Promise<VatSummaryResult> {
    // Ledger read: fetch INVOICE + INVOICE_VOID rows against
    // VAT_PAYABLE across the period, PLUS the Invoice row those
    // sourceIds point at (for the .emirate + .createdAt join).
    // Prisma has no cross-table read on a scalar sourceId — split
    // into two queries and join in-memory.
    const [invoiceVatRows, voidVatRows, inputVatRows] = await Promise.all([
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                account: ACCOUNTS.VAT_PAYABLE,
                sourceType: "INVOICE",
                createdAt: { gte: fromDate, lt: toDate },
            },
            select: { sourceId: true, debit: true, credit: true },
        }),
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                account: ACCOUNTS.VAT_PAYABLE,
                sourceType: "INVOICE_VOID",
                createdAt: { gte: fromDate, lt: toDate },
            },
            select: { sourceId: true, debit: true, credit: true },
        }),
        prisma.ledgerEntry.findMany({
            where: {
                garageId,
                account: ACCOUNTS.VAT_INPUT,
                createdAt: { gte: fromDate, lt: toDate },
            },
            select: { debit: true, credit: true },
        }),
    ]);

    // Every sourceId we saw (unique). One query pulls all metadata.
    const invoiceIds = Array.from(
        new Set([...invoiceVatRows, ...voidVatRows].map((r) => r.sourceId)),
    );
    const invoiceMeta = invoiceIds.length
        ? await prisma.invoice.findMany({
              where: { id: { in: invoiceIds } },
              select: { id: true, emirate: true, createdAt: true },
          })
        : [];
    const metaById = new Map(invoiceMeta.map((i) => [i.id, i] as const));

    // Bucket VAT into emirate rows. Standard = INVOICE in period,
    // Adjustment = INVOICE_VOID for a prior-period invoice.
    const standardByEmirate = new Map<EmirateBucket, number>();
    const adjustmentByEmirate = new Map<EmirateBucket, number>();

    for (const r of invoiceVatRows) {
        const emirate = (metaById.get(r.sourceId)?.emirate ?? UNASSIGNED) as EmirateBucket;
        // VAT_PAYABLE is CR-normal; output VAT collected on an invoice
        // credits it. Flip sign for display.
        const contribution = Number(r.credit) - Number(r.debit);
        standardByEmirate.set(emirate, (standardByEmirate.get(emirate) ?? 0) + contribution);
    }
    for (const r of voidVatRows) {
        const meta = metaById.get(r.sourceId);
        const emirate = (meta?.emirate ?? UNASSIGNED) as EmirateBucket;
        // A void row's contribution is DR-normal (reverses the original CR).
        const contribution = Number(r.debit) - Number(r.credit);
        const originalInPeriod =
            !!meta && meta.createdAt >= fromDate && meta.createdAt < toDate;
        if (originalInPeriod) {
            // Same-quarter void: subtract from the standard column
            // (net-with-original). Flip sign to match standard's
            // CR-collected convention.
            standardByEmirate.set(
                emirate,
                (standardByEmirate.get(emirate) ?? 0) - contribution,
            );
        } else {
            // Cross-quarter void: this is the Adjustments case.
            adjustmentByEmirate.set(
                emirate,
                (adjustmentByEmirate.get(emirate) ?? 0) + contribution,
            );
        }
    }

    // Emit rows in Form 201 order. Unassigned only if it has activity.
    const { EMIRATE_ORDER } = await import("@/lib/emirate");
    const byEmirate: EmirateRow[] = [];
    for (const e of EMIRATE_ORDER) {
        const std = Math.round((standardByEmirate.get(e) ?? 0) * 100) / 100;
        const adj = Math.round((adjustmentByEmirate.get(e) ?? 0) * 100) / 100;
        if (std === 0 && adj === 0) continue;
        byEmirate.push({
            emirate: e,
            standardVat: normZero(std),
            adjustmentVat: normZero(adj),
            netVat: normZero(std - adj),
        });
    }
    const unStd = Math.round((standardByEmirate.get(UNASSIGNED) ?? 0) * 100) / 100;
    const unAdj = Math.round((adjustmentByEmirate.get(UNASSIGNED) ?? 0) * 100) / 100;
    if (unStd !== 0 || unAdj !== 0) {
        byEmirate.push({
            emirate: UNASSIGNED,
            standardVat: normZero(unStd),
            adjustmentVat: normZero(unAdj),
            netVat: normZero(unStd - unAdj),
        });
    }

    const outputVat = normZero(
        Math.round(byEmirate.reduce((s, r) => s + r.standardVat, 0) * 100) / 100,
    );
    const adjustmentsVat = normZero(
        Math.round(byEmirate.reduce((s, r) => s + r.adjustmentVat, 0) * 100) / 100,
    );
    const inputVat = normZero(balance(inputVatRows));
    const netPayable = normZero(
        Math.round((outputVat - adjustmentsVat - inputVat) * 100) / 100,
    );

    // Coverage counts — Prisma count() queries in parallel.
    const [
        expensesTotal,
        expensesWithVat,
        supplierBillsTotal,
        supplierBillsWithVat,
        invoicesInPeriod,
        invoicesWithEmirate,
    ] = await Promise.all([
        prisma.expense.count({
            where: { garageId, status: "ACTIVE", paidAt: { gte: fromDate, lt: toDate } },
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
            where: { garageId, status: { not: "VOID" }, billDate: { gte: fromDate, lt: toDate } },
        }),
        prisma.supplierBill.count({
            where: {
                garageId,
                status: { not: "VOID" },
                billDate: { gte: fromDate, lt: toDate },
                vatAmount: { gt: 0 },
            },
        }),
        prisma.invoice.count({
            where: {
                garageId,
                status: { not: "DRAFT" },
                issuedAt: { gte: fromDate, lt: toDate },
            },
        }),
        prisma.invoice.count({
            where: {
                garageId,
                status: { not: "DRAFT" },
                issuedAt: { gte: fromDate, lt: toDate },
                emirate: { not: null },
            },
        }),
    ]);

    return {
        fromDate,
        toDate,
        byEmirate,
        outputVat,
        adjustmentsVat,
        inputVat,
        netPayable,
        coverage: {
            expensesTotal,
            expensesWithVat,
            supplierBillsTotal,
            supplierBillsWithVat,
            invoicesInPeriod,
            invoicesWithEmirate,
        },
    };
}
