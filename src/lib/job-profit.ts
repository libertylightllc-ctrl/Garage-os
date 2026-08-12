import { Prisma } from "@/generated/prisma/client";

/**
 * Per-job profit computation (AR 2026-08-12, profit reporting Step 5).
 *
 * Reads only what's already frozen on the invoice + the job's closed
 * work sessions. No live catalog reads — a later PO receipt or rate
 * change never rewrites this number. See profit-reporting-spec.md
 * for the coverage / Unknown discipline, and for why margins here
 * are average-cost based (weighted-average Part.cost, not per-unit).
 *
 * All arithmetic runs on Prisma.Decimal end to end. Money never
 * touches a JS number.
 */

export type LineKind = "PART" | "LABOR" | "FEE" | string;

export interface ProfitLine {
    kind: LineKind;
    /** qty × unitPrice; already stored per line. Pre-VAT. */
    lineTotal: Prisma.Decimal | string | number;
    qty: Prisma.Decimal | string | number;
    /** Snapshotted at invoice generation; null = unknown, not zero. */
    unitCost: Prisma.Decimal | string | number | null;
}

export interface ProfitSession {
    /** Snapshotted at session close; null = unknown, not zero. */
    laborCostSnapshot: Prisma.Decimal | string | number | null;
}

export interface JobProfit {
    revenue: Prisma.Decimal;

    partsRevenue: Prisma.Decimal;
    partsCost: Prisma.Decimal;
    partsProfit: Prisma.Decimal;
    partsMarginPct: Prisma.Decimal | null; // null when partsRevenue == 0

    laborRevenue: Prisma.Decimal;
    laborCost: Prisma.Decimal;
    laborProfit: Prisma.Decimal;
    laborMarginPct: Prisma.Decimal | null;

    /** parts+labour cost (feeRevenue has no matching cost concept). */
    totalCost: Prisma.Decimal;
    /** revenue − totalCost — includes fee revenue with zero cost. */
    grossProfit: Prisma.Decimal;
    grossMarginPct: Prisma.Decimal | null;

    coverage: {
        partsCovered: number; // # PART lines with unitCost not null
        partsTotal: number;   // # PART lines total
        laborCovered: number; // # sessions with laborCostSnapshot not null
        laborTotal: number;   // # sessions total
    };
}

export function computeJobProfit(
    lines: ProfitLine[],
    sessions: ProfitSession[],
): JobProfit {
    const ZERO = new Prisma.Decimal(0);

    let revenue = ZERO;
    let partsRevenue = ZERO;
    let partsCost = ZERO;
    let laborRevenue = ZERO;
    let partsCovered = 0;
    let partsTotal = 0;

    for (const l of lines) {
        const lt = new Prisma.Decimal(l.lineTotal);
        revenue = revenue.plus(lt);
        if (l.kind === "PART") {
            partsTotal += 1;
            partsRevenue = partsRevenue.plus(lt);
            if (l.unitCost !== null && l.unitCost !== undefined) {
                partsCovered += 1;
                const cost = new Prisma.Decimal(l.unitCost).times(new Prisma.Decimal(l.qty));
                partsCost = partsCost.plus(cost);
            }
        } else if (l.kind === "LABOR") {
            laborRevenue = laborRevenue.plus(lt);
        }
        // FEE / other kinds contribute to revenue only; no cost side.
    }

    let laborCost = ZERO;
    let laborCovered = 0;
    for (const s of sessions) {
        if (s.laborCostSnapshot !== null && s.laborCostSnapshot !== undefined) {
            laborCovered += 1;
            laborCost = laborCost.plus(new Prisma.Decimal(s.laborCostSnapshot));
        }
    }
    const laborTotal = sessions.length;

    const partsProfit = partsRevenue.minus(partsCost);
    const laborProfit = laborRevenue.minus(laborCost);
    const totalCost = partsCost.plus(laborCost);
    const grossProfit = revenue.minus(totalCost);

    return {
        revenue: round2(revenue),
        partsRevenue: round2(partsRevenue),
        partsCost: round2(partsCost),
        partsProfit: round2(partsProfit),
        partsMarginPct: pct(partsProfit, partsRevenue),
        laborRevenue: round2(laborRevenue),
        laborCost: round2(laborCost),
        laborProfit: round2(laborProfit),
        laborMarginPct: pct(laborProfit, laborRevenue),
        totalCost: round2(totalCost),
        grossProfit: round2(grossProfit),
        grossMarginPct: pct(grossProfit, revenue),
        coverage: { partsCovered, partsTotal, laborCovered, laborTotal },
    };
}

function round2(d: Prisma.Decimal): Prisma.Decimal {
    return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function pct(profit: Prisma.Decimal, revenue: Prisma.Decimal): Prisma.Decimal | null {
    if (revenue.isZero()) return null;
    return profit
        .dividedBy(revenue)
        .times(100)
        .toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP);
}
