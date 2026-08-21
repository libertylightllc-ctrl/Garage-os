// Per-part profit rollup (AR 2026-08-22, profit reporting Step 7 —
// see docs/profit-reporting-spec.md).
//
// Groups every non-VOID PART InvoiceLine in the range by DESCRIPTION
// (InvoiceLine deliberately has no partId — the line is a frozen
// snapshot, see the schema comment on InvoiceLine model). Sums qty +
// revenue + cost, and applies the same "null when incomplete" rule
// as computeJobProfit: if ANY line for a part-description has a null
// unitCost, the bucket's cost/profit/margin come back as null.
// Revenue stays visible either way.
//
// Bucket key = trim(lowercase(description)). Case + surrounding
// whitespace normalised so "Front pads" and "front pads " roll into
// one row; the DISPLAYED name is the most common capitalisation
// observed. If a garage genuinely spells the same part two different
// ways (e.g. "Air filter" vs "Cabin filter") they'll show as two
// rows — that's the honest signal ("your catalogue naming is
// inconsistent"), not something to paper over here.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { scopeWhere } from "@/lib/branches";

type Scope = string | string[];

/** Minimal shape the pure bucketing function needs from an invoice line. */
export interface PartLineInput {
    description: string;
    qty: Prisma.Decimal | string | number;
    lineTotal: Prisma.Decimal | string | number;
    unitCost: Prisma.Decimal | string | number | null;
}

export interface PartProfitRow {
    /**
     * Normalised description key (lowercased + trimmed). Stable across
     * renders; use `name` for display.
     */
    key: string;
    /** Most-frequent original casing observed for this description. */
    name: string;
    /** Number of invoice lines with this description. */
    linesTotal: number;
    /** Lines with a known unitCost. linesTotal - linesCovered = unknowns. */
    linesCovered: number;
    /** Total qty sold across all lines. */
    qtySold: Prisma.Decimal;
    /** Always known — sum of lineTotal. */
    revenue: Prisma.Decimal;
    /** null when any line lacks unitCost (covered < total). */
    cost: Prisma.Decimal | null;
    /** null when cost is null. */
    profit: Prisma.Decimal | null;
    /** null when profit is null OR revenue is 0. Rounded to 1 decimal. */
    marginPct: number | null;
    /** covered/total × 100, rounded. Always known (0 if total>0 and covered=0). */
    coveragePct: number;
}

/**
 * Roll every non-VOID PART InvoiceLine in [from, to) up by partId.
 *
 * Excludes VOID invoices — a voided line was never a real sale, and
 * counting it in either revenue or cost would misstate what actually
 * moved.
 */
export async function computePartProfit(
    garageId: Scope,
    from: Date,
    to: Date,
): Promise<PartProfitRow[]> {
    const lines = await prisma.invoiceLine.findMany({
        where: {
            invoice: {
                garageId: scopeWhere(garageId),
                status: { not: "VOID" },
                issuedAt: { gte: from, lt: to },
            },
            kind: "PART",
        },
        select: {
            description: true,
            qty: true,
            lineTotal: true,
            unitCost: true,
        },
    });

    return bucketizePartLines(lines);
}

/**
 * Pure per-part bucketing — extracted so the aggregation semantics
 * (dedup by lowercased-trimmed description, null-cost propagation,
 * most-frequent-casing display name) can be exercised in-process
 * without touching Prisma.
 */
export function bucketizePartLines(lines: PartLineInput[]): PartProfitRow[] {
    const buckets = new Map<
        string,
        {
            key: string;
            /** description → count, to pick the most-used spelling for display. */
            nameCounts: Map<string, number>;
            linesTotal: number;
            linesCovered: number;
            qtySold: Prisma.Decimal;
            revenue: Prisma.Decimal;
            costAccum: Prisma.Decimal;
        }
    >();

    for (const l of lines) {
        const desc = (l.description ?? "").trim();
        if (desc === "") continue; // silently skip blank descriptions
        const key = desc.toLowerCase();
        let b = buckets.get(key);
        if (!b) {
            b = {
                key,
                nameCounts: new Map(),
                linesTotal: 0,
                linesCovered: 0,
                qtySold: new Prisma.Decimal(0),
                revenue: new Prisma.Decimal(0),
                costAccum: new Prisma.Decimal(0),
            };
            buckets.set(key, b);
        }
        b.nameCounts.set(desc, (b.nameCounts.get(desc) ?? 0) + 1);
        b.linesTotal += 1;
        const qty = new Prisma.Decimal(l.qty);
        b.qtySold = b.qtySold.plus(qty);
        b.revenue = b.revenue.plus(new Prisma.Decimal(l.lineTotal));
        if (l.unitCost !== null && l.unitCost !== undefined) {
            b.linesCovered += 1;
            b.costAccum = b.costAccum.plus(qty.mul(new Prisma.Decimal(l.unitCost)));
        }
    }

    const rows: PartProfitRow[] = [];
    for (const b of buckets.values()) {
        // Display name = the spelling used most often for this bucket.
        // Ties broken by first-seen insertion order (Map iteration order).
        let bestName = "";
        let bestCount = -1;
        for (const [name, count] of b.nameCounts) {
            if (count > bestCount) {
                bestName = name;
                bestCount = count;
            }
        }
        const incomplete = b.linesCovered < b.linesTotal;
        const cost = incomplete ? null : b.costAccum;
        const profit = cost === null ? null : b.revenue.minus(cost);
        const revenueNum = Number(b.revenue);
        const marginPct =
            profit === null || revenueNum === 0
                ? null
                : Math.round((Number(profit) / revenueNum) * 1000) / 10;
        rows.push({
            key: b.key,
            name: bestName,
            linesTotal: b.linesTotal,
            linesCovered: b.linesCovered,
            qtySold: b.qtySold,
            revenue: b.revenue,
            cost,
            profit,
            marginPct,
            coveragePct:
                b.linesTotal === 0
                    ? 0
                    : Math.round((b.linesCovered / b.linesTotal) * 100),
        });
    }
    return rows;
}
