// Per-period profit aggregation (AR 2026-08-22, profit reporting
// Step 6 — see docs/profit-reporting-spec.md).
//
// Reuses computeJobProfit per invoice so the "unknown when incomplete"
// rule that governs the per-job card also governs the per-period
// rollup — a job whose parts side is Unknown does NOT contribute a
// zero-cost fake-profit to the period total. It's excluded from the
// PROFIT sum entirely, and drops the coverage percentage. Revenue is
// always included (it's a known amount either way).
//
// The frozen-snapshot discipline still holds: reads never touch
// Part.cost live — cost math comes from InvoiceLine.unitCost +
// WorkSession.laborCostSnapshot + JobPartReceipt data, all
// snapshotted at write time.
//
// Aggregation shape mirrors what per-job returns so the widget can
// render the same three stats (revenue / profit / coverage) at the
// same visual weight the spec demands.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { scopeWhere } from "@/lib/branches";
import { computeJobProfit, type JobProfit } from "@/lib/job-profit";
import { compareReceiptToInvoice } from "@/lib/direct-fit-receipt";

type Scope = string | string[];

export interface PeriodProfit {
    /** Always known — sum of every invoice's total (excluding VOID). */
    revenue: Prisma.Decimal;
    /**
     * Sum of grossProfit for invoices with FULLY-known cost data.
     * Invoices with any Unknown side (parts or labour or receipts)
     * are excluded from this total AND count against coverage. null
     * only when zero invoices in the period are fully covered — a
     * signal to the widget to render "—" instead of "AED 0.00".
     */
    profit: Prisma.Decimal | null;
    coverage: {
        /** Invoices where computeJobProfit returned a non-null grossProfit. */
        covered: number;
        /** Every non-VOID invoice in the range. */
        total: number;
        /**
         * covered/total × 100, rounded to nearest integer. null when
         * total == 0 (no invoices at all — nothing to render).
         */
        pct: number | null;
    };
    /** Count of invoices whose grossProfit was null. Debug/diag surface. */
    uncoveredCount: number;
}

/**
 * Aggregate profit across every non-VOID invoice issued in [from, to).
 *
 * Loops per-invoice on purpose. GroupBy in SQL would flatten line data
 * and lose the per-line null-cost signal — the exact bug (fake zero
 * cost, fake 100% margin) that Step 5 was tightened against on
 * 2026-08-13. Reuse of computeJobProfit is the whole point.
 *
 * `to` is exclusive; pass `startOfMonth(next)` for a full-month
 * rollup. `from` inclusive.
 */
export async function computePeriodProfit(
    garageId: Scope,
    from: Date,
    to: Date,
): Promise<PeriodProfit> {
    // Pull every non-VOID invoice in range with lines + sessions +
    // receipts already joined. This is the same shape computeJobProfit
    // takes per invoice; one query instead of N+1.
    const invoices = await prisma.invoice.findMany({
        where: {
            garageId: scopeWhere(garageId),
            status: { not: "VOID" },
            issuedAt: { gte: from, lt: to },
        },
        select: {
            id: true,
            jobCardId: true,
            total: true,
            lines: { select: { kind: true, qty: true, lineTotal: true, unitCost: true } },
        },
    });

    if (invoices.length === 0) {
        return {
            revenue: new Prisma.Decimal(0),
            profit: null,
            coverage: { covered: 0, total: 0, pct: null },
            uncoveredCount: 0,
        };
    }

    // Sessions + receipts, both scoped by jobCardId set. Two queries
    // total — the trade-off is a small in-JS bucket sort for a bounded
    // per-invoice cost that stays linear in the row count.
    const jobIds = [...new Set(invoices.map((i) => i.jobCardId))];
    const [sessions, receipts] = await Promise.all([
        prisma.workSession.findMany({
            where: { jobCardId: { in: jobIds }, endedAt: { not: null } },
            select: {
                jobCardId: true,
                laborCostSnapshot: true,
                startedAt: true,
                endedAt: true,
            },
        }),
        prisma.jobPartReceipt.findMany({
            where: { jobCardId: { in: jobIds } },
            select: {
                jobCardId: true,
                qty: true,
                receivedUnitCost: true,
                purchaseOrderLine: {
                    select: {
                        sourceEstimateLine: {
                            select: {
                                unitCost: true,
                                estimate: { select: { invoice: { select: { id: true } } } },
                            },
                        },
                    },
                },
            },
        }),
    ]);

    const sessionsByJob = new Map<string, typeof sessions>();
    for (const s of sessions) {
        const arr = sessionsByJob.get(s.jobCardId) ?? [];
        arr.push(s);
        sessionsByJob.set(s.jobCardId, arr);
    }
    const receiptsByJob = new Map<string, typeof receipts>();
    for (const r of receipts) {
        const arr = receiptsByJob.get(r.jobCardId) ?? [];
        arr.push(r);
        receiptsByJob.set(r.jobCardId, arr);
    }

    let revenue = new Prisma.Decimal(0);
    let profit = new Prisma.Decimal(0);
    let covered = 0;
    let uncovered = 0;

    for (const inv of invoices) {
        revenue = revenue.plus(new Prisma.Decimal(inv.total));

        const invSessions = (sessionsByJob.get(inv.jobCardId) ?? []).map((s) => ({
            laborCostSnapshot: s.laborCostSnapshot,
            startedAt: s.startedAt ?? undefined,
            endedAt: s.endedAt ?? undefined,
        }));
        const invReceipts = (receiptsByJob.get(inv.jobCardId) ?? []).map((r) => {
            const cmp = compareReceiptToInvoice({
                receivedUnitCost: Number(r.receivedUnitCost),
                qty: r.qty,
                sourceEstimateLine: r.purchaseOrderLine.sourceEstimateLine
                    ? {
                          unitCost:
                              r.purchaseOrderLine.sourceEstimateLine.unitCost === null
                                  ? null
                                  : Number(r.purchaseOrderLine.sourceEstimateLine.unitCost),
                          estimateHasInvoice: Boolean(
                              r.purchaseOrderLine.sourceEstimateLine.estimate.invoice,
                          ),
                      }
                    : null,
            });
            return { status: cmp.status, totalDelta: cmp.totalDelta };
        });

        const p: JobProfit = computeJobProfit(inv.lines, invSessions, invReceipts);
        if (p.grossProfit === null) {
            uncovered += 1;
        } else {
            covered += 1;
            profit = profit.plus(p.grossProfit);
        }
    }

    const total = invoices.length;
    return {
        revenue,
        // null when NO invoice was covered — surfaces as "—" rather
        // than an accidentally-honest "AED 0.00" on a 0/N period.
        profit: covered === 0 ? null : profit,
        coverage: {
            covered,
            total,
            pct: total === 0 ? null : Math.round((covered / total) * 100),
        },
        uncoveredCount: uncovered,
    };
}
