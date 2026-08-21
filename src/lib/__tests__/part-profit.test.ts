// Per-part bucketing (AR 2026-08-22, Batch 5 Step 7).
//
// Pure — exercises bucketizePartLines directly with hand-built line
// inputs so the null-when-incomplete rule and description
// normalisation semantics are pinned without touching Prisma.

import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { bucketizePartLines } from "@/lib/part-profit";

const D = (v: string | number) => new Prisma.Decimal(v);

describe("bucketizePartLines — full coverage", () => {
    it("sums qty + revenue + cost across every line for one description", () => {
        const rows = bucketizePartLines([
            { description: "Front brake pads", qty: 2, lineTotal: "200.00", unitCost: "60.00" },
            { description: "Front brake pads", qty: 1, lineTotal: "100.00", unitCost: "60.00" },
        ]);
        expect(rows).toHaveLength(1);
        const r = rows[0];
        expect(r.name).toBe("Front brake pads");
        expect(r.linesTotal).toBe(2);
        expect(r.linesCovered).toBe(2);
        expect(r.qtySold.equals(D(3))).toBe(true);
        expect(r.revenue.equals(D("300.00"))).toBe(true);
        expect(r.cost?.equals(D("180.00"))).toBe(true);
        expect(r.profit?.equals(D("120.00"))).toBe(true);
        expect(r.marginPct).toBe(40);
        expect(r.coveragePct).toBe(100);
    });

    it("computes marginPct as profit/revenue rounded to 1 decimal", () => {
        // revenue 350, cost 220, profit 130. margin = 130/350 = 37.14…% → 37.1
        const [r] = bucketizePartLines([
            { description: "Oil filter", qty: 1, lineTotal: "150.00", unitCost: "100.00" },
            { description: "Oil filter", qty: 2, lineTotal: "200.00", unitCost: "60.00" },
        ]);
        expect(r.marginPct).toBe(37.1);
    });
});

describe("bucketizePartLines — incomplete coverage", () => {
    it("returns null cost/profit/margin when ANY line lacks unitCost — revenue stays known", () => {
        const [r] = bucketizePartLines([
            { description: "Air filter", qty: 1, lineTotal: "80.00", unitCost: "30.00" },
            { description: "Air filter", qty: 2, lineTotal: "160.00", unitCost: null },
        ]);
        // Revenue still visible — a known amount either way.
        expect(r.revenue.equals(D("240.00"))).toBe(true);
        expect(r.linesTotal).toBe(2);
        expect(r.linesCovered).toBe(1);
        expect(r.coveragePct).toBe(50);
        // Cost / profit / margin blanked — "a wrong number is worse
        // than no number" — AR 2026-08-13.
        expect(r.cost).toBeNull();
        expect(r.profit).toBeNull();
        expect(r.marginPct).toBeNull();
    });

    it("100% coverage with zero revenue leaves margin null (division by zero)", () => {
        // Freebie line — revenue 0, cost known. Profit is negative
        // known; margin can't be computed.
        const [r] = bucketizePartLines([
            { description: "Courtesy part", qty: 1, lineTotal: "0.00", unitCost: "40.00" },
        ]);
        expect(r.cost?.equals(D("40.00"))).toBe(true);
        expect(r.profit?.equals(D("-40.00"))).toBe(true);
        expect(r.marginPct).toBeNull();
    });
});

describe("bucketizePartLines — description normalisation", () => {
    it("groups case + whitespace variants of the same description into ONE row", () => {
        const rows = bucketizePartLines([
            { description: "Air filter", qty: 1, lineTotal: "40.00", unitCost: "20.00" },
            { description: "air filter", qty: 1, lineTotal: "40.00", unitCost: "20.00" },
            { description: "  Air filter ", qty: 1, lineTotal: "40.00", unitCost: "20.00" },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].linesTotal).toBe(3);
        // Display name = the spelling used most often. "Air filter"
        // appeared twice (once with padding — trimmed away), "air
        // filter" once. Trimmed "Air filter" wins.
        expect(rows[0].name).toBe("Air filter");
    });

    it("keeps genuinely different names as separate rows", () => {
        const rows = bucketizePartLines([
            { description: "Front brake pads", qty: 1, lineTotal: "100.00", unitCost: "50.00" },
            { description: "Rear brake pads", qty: 1, lineTotal: "100.00", unitCost: "50.00" },
        ]);
        expect(rows).toHaveLength(2);
        const names = rows.map((r) => r.name).sort();
        expect(names).toEqual(["Front brake pads", "Rear brake pads"]);
    });

    it("silently drops blank/whitespace-only descriptions rather than creating a nameless bucket", () => {
        const rows = bucketizePartLines([
            { description: "", qty: 1, lineTotal: "50.00", unitCost: "10.00" },
            { description: "   ", qty: 1, lineTotal: "50.00", unitCost: "10.00" },
            { description: "Wiper blade", qty: 1, lineTotal: "50.00", unitCost: "10.00" },
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe("Wiper blade");
    });
});
