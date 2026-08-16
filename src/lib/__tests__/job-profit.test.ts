import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { computeJobProfit } from "@/lib/job-profit";

// AR 2026-08-12 profit reporting Step 5 — per-job compute.
// AR 2026-08-13 tightened: incomplete coverage returns null on
// cost / profit / margin instead of a fake-zero derived from
// partial data. Revenue stays known regardless.

const D = (v: string | number) => new Prisma.Decimal(v);

describe("computeJobProfit — full coverage", () => {
    it("computes parts + labour profit + margin % when every line has data", () => {
        // 1 PART line: qty 2 × 100 = 200 revenue, cost 60 → parts profit 80
        // 1 LABOR line: 150 revenue, 1 session cost 60 → labour profit 90
        // total revenue 350, cost 180, gross 170, margin 48.6%
        const out = computeJobProfit(
            [
                { kind: "PART", qty: 2, lineTotal: "200.00", unitCost: "60.00" },
                { kind: "LABOR", qty: 1, lineTotal: "150.00", unitCost: null },
            ],
            [{ laborCostSnapshot: "60.00" }],
        );
        expect(out.revenue.equals(D("350.00"))).toBe(true);
        expect(out.partsCost?.equals(D("120.00"))).toBe(true);
        expect(out.laborCost?.equals(D("60.00"))).toBe(true);
        expect(out.grossProfit?.equals(D("170.00"))).toBe(true);
        expect(out.grossMarginPct?.equals(D("48.6"))).toBe(true);
    });

    it("reports full coverage counts on both sides", () => {
        const out = computeJobProfit(
            [
                { kind: "PART", qty: 1, lineTotal: "100", unitCost: "40" },
                { kind: "PART", qty: 1, lineTotal: "50", unitCost: "20" },
            ],
            [{ laborCostSnapshot: "60" }, { laborCostSnapshot: "40" }],
        );
        expect(out.coverage).toEqual({
            partsCovered: 2,
            partsTotal: 2,
            laborCovered: 2,
            laborTotal: 2,
            receiptsTotal: 0,
            receiptsMismatched: 0,
            receiptsMismatchTotalDelta: null,
            receiptsUnlinkable: 0,
        });
    });

    // AR 2026-08-16 receipt-coverage rule (rewritten): receipts are
    // PURE WARNINGS — they never suppress a number the invoice can
    // support. Invoice with full cost data → parts margin shows.
    // Mismatched / unlinkable counts + delta feed a warning line
    // on the card.
    it("mismatched receipt does NOT suppress parts cost — number stands, delta is reported", () => {
        const out = computeJobProfit(
            [{ kind: "PART", qty: 1, lineTotal: "100", unitCost: "40" }],
            [],
            [{ status: "mismatch", totalDelta: 5 }],
        );
        expect(out.partsCost?.toString()).toBe("40");
        expect(out.partsProfit?.toString()).toBe("60");
        expect(out.coverage.receiptsMismatched).toBe(1);
        expect(out.coverage.receiptsMismatchTotalDelta?.toString()).toBe("5");
        expect(out.coverage.receiptsUnlinkable).toBe(0);
    });

    it("unlinkable receipt does NOT suppress parts cost — delta stays null", () => {
        const out = computeJobProfit(
            [{ kind: "PART", qty: 1, lineTotal: "100", unitCost: "40" }],
            [],
            [{ status: "unlinkable", totalDelta: null }],
        );
        expect(out.partsCost?.toString()).toBe("40");
        expect(out.coverage.receiptsUnlinkable).toBe(1);
        expect(out.coverage.receiptsMismatchTotalDelta).toBeNull();
    });

    it("only invoice-side incompleteness suppresses parts cost", () => {
        // Line without unitCost → parts side unknown regardless of
        // any receipt status.
        const out = computeJobProfit(
            [{ kind: "PART", qty: 1, lineTotal: "100", unitCost: null }],
            [],
            [{ status: "reconciled", totalDelta: null }],
        );
        expect(out.partsCost).toBeNull();
    });

    it("sums mismatch deltas across multiple receipts (signed)", () => {
        // Two mismatches, one over-cost, one under-cost. Total delta
        // is the signed sum so the owner sees the net direction.
        const out = computeJobProfit(
            [{ kind: "PART", qty: 1, lineTotal: "100", unitCost: "40" }],
            [],
            [
                { status: "mismatch", totalDelta: 20 },
                { status: "mismatch", totalDelta: -5 },
            ],
        );
        expect(out.coverage.receiptsMismatched).toBe(2);
        expect(out.coverage.receiptsMismatchTotalDelta?.toString()).toBe("15");
    });

    it("reconciled receipts contribute nothing to delta or counts", () => {
        const out = computeJobProfit(
            [{ kind: "PART", qty: 1, lineTotal: "100", unitCost: "40" }],
            [],
            [
                { status: "reconciled", totalDelta: null },
                { status: "reconciled", totalDelta: null },
            ],
        );
        expect(out.coverage.receiptsTotal).toBe(2);
        expect(out.coverage.receiptsMismatched).toBe(0);
        expect(out.coverage.receiptsUnlinkable).toBe(0);
        expect(out.coverage.receiptsMismatchTotalDelta).toBeNull();
    });
});

describe("computeJobProfit — incomplete coverage returns null, not fake zeros (AR 2026-08-13)", () => {
    it("0-of-5 parts covered → parts cost / profit / margin all null (the exact bug AR reported)", () => {
        // The staging repro: 5 PART lines with unitCost=null, one
        // LABOR line at 200. Revenue is real: 5×30 + 200 = 350.
        // Parts side is 100% unknown; cost/profit/margin MUST NOT
        // be computed as 0 / 350 / 100%.
        const out = computeJobProfit(
            [
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: null },
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: null },
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: null },
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: null },
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: null },
                { kind: "LABOR", qty: 1, lineTotal: "200", unitCost: null },
            ],
            [],
        );
        // Revenue is always known.
        expect(out.revenue.equals(D("350.00"))).toBe(true);
        expect(out.partsRevenue.equals(D("150.00"))).toBe(true);
        expect(out.laborRevenue.equals(D("200.00"))).toBe(true);
        // Everything cost-side on parts is null. NOT zero.
        expect(out.partsCost).toBeNull();
        expect(out.partsProfit).toBeNull();
        expect(out.partsMarginPct).toBeNull();
        // Headline is null too — one side unknown → total unknown.
        expect(out.totalCost).toBeNull();
        expect(out.grossProfit).toBeNull();
        expect(out.grossMarginPct).toBeNull();
        // Coverage counts still reported so the card can explain WHY.
        expect(out.coverage.partsCovered).toBe(0);
        expect(out.coverage.partsTotal).toBe(5);
    });

    it("3-of-5 parts covered → parts side null (partial data is still incomplete)", () => {
        // AR 2026-08-13: "A number that's wrong by an unknown amount
        // is worse than no number." Even 3-of-5 → em-dash.
        const out = computeJobProfit(
            [
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: "10" },
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: "10" },
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: "10" },
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: null },
                { kind: "PART", qty: 1, lineTotal: "30", unitCost: null },
            ],
            [],
        );
        expect(out.partsRevenue.equals(D("150.00"))).toBe(true);
        expect(out.partsCost).toBeNull();
        expect(out.partsProfit).toBeNull();
        expect(out.partsMarginPct).toBeNull();
        expect(out.coverage.partsCovered).toBe(3);
        expect(out.coverage.partsTotal).toBe(5);
    });

    it("labour side incomplete → labour cost/profit/margin null but labour REVENUE stays visible", () => {
        // AR 2026-08-13: labour revenue must be present on the card
        // even when cost is unknown. Test the compute layer's shape;
        // the card render pins the visibility.
        const out = computeJobProfit(
            [{ kind: "LABOR", qty: 1, lineTotal: "200", unitCost: null }],
            [{ laborCostSnapshot: null }, { laborCostSnapshot: null }],
        );
        expect(out.laborRevenue.equals(D("200.00"))).toBe(true);
        expect(out.laborCost).toBeNull();
        expect(out.laborProfit).toBeNull();
        expect(out.laborMarginPct).toBeNull();
        expect(out.coverage.laborCovered).toBe(0);
        expect(out.coverage.laborTotal).toBe(2);
    });

    it("one side complete + the other incomplete → total is still null", () => {
        // Parts fully covered, labour partial. Headline can't add
        // known parts to guessed labour and call it gross profit.
        const out = computeJobProfit(
            [
                { kind: "PART", qty: 1, lineTotal: "100", unitCost: "40" },
                { kind: "LABOR", qty: 1, lineTotal: "150", unitCost: null },
            ],
            [{ laborCostSnapshot: "60" }, { laborCostSnapshot: null }],
        );
        expect(out.partsCost?.equals(D("40.00"))).toBe(true);
        expect(out.laborCost).toBeNull();
        expect(out.totalCost).toBeNull();
        expect(out.grossProfit).toBeNull();
        expect(out.grossMarginPct).toBeNull();
    });
});

describe("computeJobProfit — trivially known sides", () => {
    it("zero parts lines counts as 'known parts side' — total not blocked by parts", () => {
        // A pure-labour job: no parts to be missing. partsCost is a
        // real 0 (nothing was sold). If labour is fully covered,
        // the headline is a real number.
        const out = computeJobProfit(
            [{ kind: "LABOR", qty: 1, lineTotal: "100", unitCost: null }],
            [{ laborCostSnapshot: "40" }],
        );
        expect(out.partsCost?.equals(D("0.00"))).toBe(true);
        expect(out.laborCost?.equals(D("40.00"))).toBe(true);
        expect(out.totalCost?.equals(D("40.00"))).toBe(true);
        expect(out.grossProfit?.equals(D("60.00"))).toBe(true);
        expect(out.grossMarginPct?.equals(D("60"))).toBe(true);
    });

    it("zero sessions counts as 'known labour side' — labourCost is a genuine 0", () => {
        const out = computeJobProfit(
            [{ kind: "PART", qty: 1, lineTotal: "100", unitCost: "40" }],
            [],
        );
        expect(out.laborCost?.equals(D("0.00"))).toBe(true);
        expect(out.partsCost?.equals(D("40.00"))).toBe(true);
        expect(out.totalCost?.equals(D("40.00"))).toBe(true);
        expect(out.grossProfit?.equals(D("60.00"))).toBe(true);
    });
});

describe("computeJobProfit — degenerate", () => {
    it("zero revenue → margin is null (never divide by zero)", () => {
        const out = computeJobProfit([], []);
        expect(out.revenue.equals(D("0"))).toBe(true);
        expect(out.grossMarginPct).toBeNull();
        expect(out.partsMarginPct).toBeNull();
        expect(out.laborMarginPct).toBeNull();
    });

    it("cost > revenue → negative margin (real number, not clamped, when fully known)", () => {
        const out = computeJobProfit(
            [{ kind: "PART", qty: 1, lineTotal: "50", unitCost: "70" }],
            [],
        );
        expect(out.grossProfit?.equals(D("-20"))).toBe(true);
        expect(out.grossMarginPct?.equals(D("-40"))).toBe(true);
    });

    it("FEE lines contribute to revenue only, no cost side", () => {
        const out = computeJobProfit(
            [{ kind: "FEE", qty: 1, lineTotal: "25", unitCost: null }],
            [],
        );
        expect(out.revenue.equals(D("25.00"))).toBe(true);
        // No parts, no labour, no unknowns → total cost is genuinely 0.
        expect(out.grossProfit?.equals(D("25.00"))).toBe(true);
        expect(out.grossMarginPct?.equals(D("100"))).toBe(true);
    });
});
