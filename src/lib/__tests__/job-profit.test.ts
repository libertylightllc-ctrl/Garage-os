import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { computeJobProfit } from "@/lib/job-profit";

// AR 2026-08-12 profit reporting Step 5 — pins the per-job compute.

const D = (v: string | number) => new Prisma.Decimal(v);

describe("computeJobProfit — happy path", () => {
    it("computes parts + labour profit + margin %", () => {
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
        expect(out.partsCost.equals(D("120.00"))).toBe(true);
        expect(out.laborCost.equals(D("60.00"))).toBe(true);
        expect(out.grossProfit.equals(D("170.00"))).toBe(true);
        expect(out.grossMarginPct?.equals(D("48.6"))).toBe(true);
    });

    it("full coverage — every PART line has unitCost, every session has snapshot", () => {
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
        });
    });
});

describe("computeJobProfit — Unknown coverage", () => {
    it("PART line with null unitCost counts into partsTotal but not partsCost", () => {
        // 2 PART lines: one has cost, one doesn't. Cost side only sees
        // the covered one; total sees both. Owner sees "1 of 2".
        const out = computeJobProfit(
            [
                { kind: "PART", qty: 1, lineTotal: "100", unitCost: "40" },
                { kind: "PART", qty: 1, lineTotal: "80", unitCost: null },
            ],
            [],
        );
        expect(out.partsRevenue.equals(D("180.00"))).toBe(true);
        expect(out.partsCost.equals(D("40.00"))).toBe(true);
        expect(out.coverage.partsCovered).toBe(1);
        expect(out.coverage.partsTotal).toBe(2);
    });

    it("session with null snapshot counts into laborTotal but not laborCost", () => {
        // The whole point: an unknown-rate session must not read as
        // "worked for free" (zero cost, 100% margin).
        const out = computeJobProfit(
            [{ kind: "LABOR", qty: 1, lineTotal: "150", unitCost: null }],
            [
                { laborCostSnapshot: null },
                { laborCostSnapshot: null },
            ],
        );
        expect(out.laborCost.equals(D("0.00"))).toBe(true);
        expect(out.coverage.laborCovered).toBe(0);
        expect(out.coverage.laborTotal).toBe(2);
        // Renders on the card as "labour rate not set" — checked in
        // the component-level render tests.
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

    it("cost > revenue → negative margin (real, not clamped)", () => {
        // Sold at loss. The number must show negative — hiding a
        // negative margin would be dishonest.
        const out = computeJobProfit(
            [{ kind: "PART", qty: 1, lineTotal: "50", unitCost: "70" }],
            [],
        );
        expect(out.grossProfit.equals(D("-20"))).toBe(true);
        expect(out.grossMarginPct?.equals(D("-40"))).toBe(true);
    });

    it("FEE lines contribute to revenue only, no cost side", () => {
        const out = computeJobProfit(
            [{ kind: "FEE", qty: 1, lineTotal: "25", unitCost: null }],
            [],
        );
        expect(out.revenue.equals(D("25.00"))).toBe(true);
        expect(out.grossProfit.equals(D("25.00"))).toBe(true);
        expect(out.grossMarginPct?.equals(D("100"))).toBe(true);
    });
});
