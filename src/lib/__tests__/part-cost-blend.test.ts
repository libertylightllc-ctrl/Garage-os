import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { blendPartCost } from "@/lib/part-cost-blend";

// Both branches (REPLACE and WEIGHTED AVERAGE) covered plus the edge
// cases the receive action can plausibly hand in. All arithmetic runs
// on Prisma.Decimal end-to-end — comparisons use .equals() rather than
// toBe so we don't accidentally rely on JS number coercion round-trips.

function D(v: string | number): Prisma.Decimal {
    return new Prisma.Decimal(v);
}

describe("blendPartCost — REPLACE branch (empty history)", () => {
    it("qtyOnHand=0, current=0 → received wins", () => {
        const out = blendPartCost({
            currentCost: 0,
            qtyOnHand: 0,
            receivedUnitCost: "25.50",
            receivedQty: 10,
        });
        expect(out.equals(D("25.50"))).toBe(true);
    });

    it("qtyOnHand=0 but current > 0 (stale catalogue) → received wins", () => {
        // Owner set 100 by hand, sold every unit, delivery says 90 →
        // replace, not blend against the no-longer-held stock.
        const out = blendPartCost({
            currentCost: "100.00",
            qtyOnHand: 0,
            receivedUnitCost: "90.00",
            receivedQty: 5,
        });
        expect(out.equals(D("90.00"))).toBe(true);
    });

    it("current=0 but stock in hand (seeded placeholder) → received wins", () => {
        // The single most common real case in DCM today: CSV import
        // wrote cost=0 as a default, qtyOnHand > 0 was manually set.
        // First receive corrects the catalogue to the real number.
        const out = blendPartCost({
            currentCost: 0,
            qtyOnHand: 12,
            receivedUnitCost: "40.00",
            receivedQty: 6,
        });
        expect(out.equals(D("40.00"))).toBe(true);
    });

    it("qtyOnHand negative (defensive) → replace", () => {
        // Should never happen — receive action guards it — but the
        // helper stays total. A negative on-hand means someone's
        // accounting is wrong, and dividing by (negative + received)
        // could produce nonsense; replace is the safest recovery.
        const out = blendPartCost({
            currentCost: "50.00",
            qtyOnHand: -3,
            receivedUnitCost: "45.00",
            receivedQty: 10,
        });
        expect(out.equals(D("45.00"))).toBe(true);
    });
});

describe("blendPartCost — WEIGHTED AVERAGE branch (real stock, real cost)", () => {
    it("equal weights: 10 @ 20 + 10 @ 30 → 25", () => {
        const out = blendPartCost({
            currentCost: "20.00",
            qtyOnHand: 10,
            receivedUnitCost: "30.00",
            receivedQty: 10,
        });
        expect(out.equals(D("25.00"))).toBe(true);
    });

    it("skewed by qty: 90 @ 20 + 10 @ 100 → 28", () => {
        // (90×20 + 10×100) / 100 = (1800 + 1000) / 100 = 28.00
        const out = blendPartCost({
            currentCost: "20.00",
            qtyOnHand: 90,
            receivedUnitCost: "100.00",
            receivedQty: 10,
        });
        expect(out.equals(D("28.00"))).toBe(true);
    });

    it("rounds to 2 dp: 3 @ 10 + 4 @ 15 → 12.86 (12.857… rounded)", () => {
        // (3×10 + 4×15) / 7 = (30 + 60) / 7 = 90/7 = 12.857142…
        // → 12.86 half-up.
        const out = blendPartCost({
            currentCost: "10.00",
            qtyOnHand: 3,
            receivedUnitCost: "15.00",
            receivedQty: 4,
        });
        expect(out.equals(D("12.86"))).toBe(true);
    });

    it("half-up rounding — .5 rounds AWAY from zero, not banker's", () => {
        // (1 × 10.005 + 1 × 10.005) / 2 = 10.005 → 10.01 half-up.
        // Prisma.Decimal default is HALF_EVEN which would give 10.00;
        // we override to HALF_UP in the helper so the invoice
        // .toFixed(2) rendering matches.
        const out = blendPartCost({
            currentCost: "10.005",
            qtyOnHand: 1,
            receivedUnitCost: "10.005",
            receivedQty: 1,
        });
        expect(out.equals(D("10.01"))).toBe(true);
    });

    it("high-precision preserved: 100 @ 12.34 + 50 @ 15.67 → 13.45", () => {
        // (100×12.34 + 50×15.67) / 150 = (1234 + 783.5) / 150
        //                               = 2017.5 / 150
        //                               = 13.45
        const out = blendPartCost({
            currentCost: "12.34",
            qtyOnHand: 100,
            receivedUnitCost: "15.67",
            receivedQty: 50,
        });
        expect(out.equals(D("13.45"))).toBe(true);
    });

    it("no drift on identity: N @ P + M @ P → still P", () => {
        // Buying more of the exact same cost never moves the number.
        const out = blendPartCost({
            currentCost: "17.50",
            qtyOnHand: 7,
            receivedUnitCost: "17.50",
            receivedQty: 3,
        });
        expect(out.equals(D("17.50"))).toBe(true);
    });
});

describe("blendPartCost — defensive edge cases", () => {
    it("null receivedUnitCost → currentCost passes through unchanged", () => {
        // A future caller that forgets the guard shouldn't corrupt
        // the catalogue with NaN. Returns whatever was there before,
        // rounded to 2 dp.
        const out = blendPartCost({
            currentCost: "40.505",
            qtyOnHand: 5,
            receivedUnitCost: null,
            receivedQty: 3,
        });
        expect(out.equals(D("40.51"))).toBe(true);
    });

    it("receivedQty = 0 → no change (weight is zero)", () => {
        const out = blendPartCost({
            currentCost: "30.00",
            qtyOnHand: 10,
            receivedUnitCost: "50.00",
            receivedQty: 0,
        });
        expect(out.equals(D("30.00"))).toBe(true);
    });

    it("accepts strings + numbers on inputs (both are real Prisma shapes)", () => {
        // Prisma hands Decimal fields back as its own class; raw
        // SQL sometimes hands them back as strings; a caller
        // computing an intermediate value may pass a JS number.
        // All three round-trip identically here.
        const out1 = blendPartCost({
            currentCost: "20",
            qtyOnHand: 10,
            receivedUnitCost: "30",
            receivedQty: 10,
        });
        const out2 = blendPartCost({
            currentCost: 20,
            qtyOnHand: 10,
            receivedUnitCost: 30,
            receivedQty: 10,
        });
        const out3 = blendPartCost({
            currentCost: new Prisma.Decimal("20.00"),
            qtyOnHand: 10,
            receivedUnitCost: new Prisma.Decimal("30.00"),
            receivedQty: 10,
        });
        expect(out1.equals(D("25.00"))).toBe(true);
        expect(out2.equals(D("25.00"))).toBe(true);
        expect(out3.equals(D("25.00"))).toBe(true);
    });
});
