import { Prisma } from "@/generated/prisma/client";

/**
 * Per-job profit computation (AR 2026-08-12, profit reporting Step 5;
 * incomplete-coverage semantics tightened AR 2026-08-13 after the
 * card was shown returning Cost=0 / Margin=100% on a job whose parts
 * coverage was 0-of-5 — the exact fake-zero we designed against).
 *
 * Reads only what's already frozen on the invoice + the job's closed
 * work sessions. No live catalog reads — a later PO receipt or rate
 * change never rewrites this number. See profit-reporting-spec.md
 * for the coverage / Unknown discipline, and for why margins here
 * are average-cost based (weighted-average Part.cost, not per-unit).
 *
 * Rule for incomplete coverage: if ANY line in a side lacks cost
 * data, the WHOLE side's cost / profit / margin come back as null,
 * not as a computed-from-what-we-know number. Revenue stays visible
 * because it's known regardless. "A number that's wrong by an
 * unknown amount is worse than no number" — AR 2026-08-13.
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
    /** Always known — sum of every line total. */
    revenue: Prisma.Decimal;

    /** Always known — sum of PART line totals. */
    partsRevenue: Prisma.Decimal;
    /** null when partsCovered < partsTotal (any part has no cost data). */
    partsCost: Prisma.Decimal | null;
    /** null when partsCost is null (can't subtract unknown from known). */
    partsProfit: Prisma.Decimal | null;
    /** null when partsProfit is null OR partsRevenue is 0. */
    partsMarginPct: Prisma.Decimal | null;

    /** Always known — sum of LABOR line totals. */
    laborRevenue: Prisma.Decimal;
    /** null when laborCovered < laborTotal OR laborTotal > 0 with no rate. */
    laborCost: Prisma.Decimal | null;
    laborProfit: Prisma.Decimal | null;
    laborMarginPct: Prisma.Decimal | null;

    /** null when EITHER side is incomplete. Parts+labour only (fees excluded). */
    totalCost: Prisma.Decimal | null;
    /** null when totalCost is null. */
    grossProfit: Prisma.Decimal | null;
    grossMarginPct: Prisma.Decimal | null;

    coverage: {
        partsCovered: number; // # PART lines with unitCost not null
        partsTotal: number;   // # PART lines total
        laborCovered: number; // # sessions with laborCostSnapshot not null
        laborTotal: number;   // # sessions total
        // Direct-fit receipt coverage (AR 2026-08-16; rewritten same
        // day after INV-2026-0048 review). Purely informational —
        // parts margin is NOT suppressed based on receipts, only on
        // missing InvoiceLine.unitCost. See compareReceiptToInvoice
        // in src/lib/direct-fit-receipt.ts for the per-receipt
        // status decision. AR's rule: "we don't know" justifies a
        // dash; "we know, but a later receipt says something
        // different" is a number plus a caveat.
        receiptsTotal: number;
        // Receipts whose paid cost differs from the invoiced cost
        // (source estimate line + invoice both present, values
        // disagree). Card renders a warning line with the total
        // delta so the owner sees BY HOW MUCH the invoiced cost
        // may be understating / overstating parts cost.
        receiptsMismatched: number;
        // Signed AED total of (received - invoiced) × qty across
        // every mismatched receipt. Positive → shop paid more than
        // invoiced (true cost worse than card shows). Negative →
        // shop paid less. null when there are zero mismatched
        // receipts (nothing to sum).
        receiptsMismatchTotalDelta: Prisma.Decimal | null;
        // Receipts that CAN'T be checked against the invoice — no
        // source estimate line (manually-added PO), or source has
        // no unitCost, or estimate not invoiced. Card renders a
        // lighter note prompting the owner to verify manually.
        receiptsUnlinkable: number;
    };
}

/**
 * Direct-fit receipt input to computeJobProfit. Caller passes the
 * per-receipt comparison already computed via compareReceiptToInvoice
 * so this module stays pure (no Prisma joins).
 */
export interface ProfitReceipt {
    /** "reconciled" | "mismatch" | "unlinkable" */
    status: "reconciled" | "mismatch" | "unlinkable";
    /**
     * (received - invoiced) × qty. Present only when status is
     * "mismatch"; null otherwise (reconciled contributes zero;
     * unlinkable is uncomputable).
     */
    totalDelta: Prisma.Decimal | string | number | null;
}

export function computeJobProfit(
    lines: ProfitLine[],
    sessions: ProfitSession[],
    receipts: ProfitReceipt[] = [],
): JobProfit {
    const ZERO = new Prisma.Decimal(0);

    let revenue = ZERO;
    let partsRevenue = ZERO;
    let partsCostAccum = ZERO;
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
                partsCostAccum = partsCostAccum.plus(cost);
            }
        } else if (l.kind === "LABOR") {
            laborRevenue = laborRevenue.plus(lt);
        }
        // FEE / other kinds contribute to revenue only; no cost side.
    }

    let laborCostAccum = ZERO;
    let laborCovered = 0;
    for (const s of sessions) {
        if (s.laborCostSnapshot !== null && s.laborCostSnapshot !== undefined) {
            laborCovered += 1;
            laborCostAccum = laborCostAccum.plus(new Prisma.Decimal(s.laborCostSnapshot));
        }
    }
    const laborTotal = sessions.length;

    // Direct-fit receipt aggregates (AR 2026-08-16, rewritten same
    // day). Pure information — parts margin is NOT gated on receipt
    // status. When the invoice has cost on every line the margin
    // stands; mismatched receipts become a warning with a delta,
    // and unlinkable ones become a lighter "verify manually" note.
    const receiptsTotal = receipts.length;
    let receiptsMismatched = 0;
    let receiptsUnlinkable = 0;
    let mismatchDeltaAccum = ZERO;
    let anyMismatch = false;
    for (const r of receipts) {
        if (r.status === "mismatch") {
            receiptsMismatched += 1;
            if (r.totalDelta !== null && r.totalDelta !== undefined) {
                mismatchDeltaAccum = mismatchDeltaAccum.plus(
                    new Prisma.Decimal(r.totalDelta),
                );
                anyMismatch = true;
            }
        } else if (r.status === "unlinkable") {
            receiptsUnlinkable += 1;
        }
    }
    const receiptsMismatchTotalDelta = anyMismatch
        ? round2(mismatchDeltaAccum)
        : null;

    // Coverage-gated numbers. "Known" means every countable input has
    // a value. A side with zero countable inputs is trivially known
    // (nothing to be missing) — its cost is a genuine 0, not a
    // stand-in for an unknown. Receipt status does NOT participate
    // in this gate (see rule change above).
    const partsKnown = partsTotal === 0 || partsCovered === partsTotal;
    const laborKnown = laborTotal === 0 || laborCovered === laborTotal;

    const partsCost = partsKnown ? round2(partsCostAccum) : null;
    const partsProfit = partsCost !== null ? round2(partsRevenue.minus(partsCost)) : null;
    const partsMarginPct = partsProfit !== null ? pct(partsProfit, partsRevenue) : null;

    const laborCost = laborKnown ? round2(laborCostAccum) : null;
    const laborProfit = laborCost !== null ? round2(laborRevenue.minus(laborCost)) : null;
    const laborMarginPct = laborProfit !== null ? pct(laborProfit, laborRevenue) : null;

    // Total is only known when BOTH sides are known. A gross figure
    // that adds "known parts" to "guessed labour" is exactly the
    // fake-zero we're stopping.
    const bothKnown = partsKnown && laborKnown;
    const totalCost =
        bothKnown && partsCost !== null && laborCost !== null
            ? round2(partsCost.plus(laborCost))
            : null;
    const grossProfit = totalCost !== null ? round2(revenue.minus(totalCost)) : null;
    const grossMarginPct = grossProfit !== null ? pct(grossProfit, revenue) : null;

    return {
        revenue: round2(revenue),
        partsRevenue: round2(partsRevenue),
        partsCost,
        partsProfit,
        partsMarginPct,
        laborRevenue: round2(laborRevenue),
        laborCost,
        laborProfit,
        laborMarginPct,
        totalCost,
        grossProfit,
        grossMarginPct,
        coverage: {
            partsCovered,
            partsTotal,
            laborCovered,
            laborTotal,
            receiptsTotal,
            receiptsMismatched,
            receiptsMismatchTotalDelta,
            receiptsUnlinkable,
        },
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
