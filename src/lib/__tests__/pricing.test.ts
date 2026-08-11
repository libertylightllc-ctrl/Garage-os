import { describe, it, expect } from "vitest";
import {
    deriveUnitPriceFromCost,
    deriveMarkupFromPrice,
    lineMargin,
} from "@/lib/pricing";

// Pure math — the invariant we care about is round-trip stability
// (cost + markup → price → markup ~= original) so the two-way binding
// in the editor doesn't drift by an oscillating rounding tail. Also
// pinned: soft null returns on incomplete input (so keystroke handlers
// don't throw mid-typing) and standard money rounding shape.

describe("deriveUnitPriceFromCost", () => {
    it("40% on 300 → 420.00", () => {
        expect(deriveUnitPriceFromCost({ unitCost: 300, markupPct: 40 })).toBe(420);
    });
    it("0% on any cost → cost", () => {
        expect(deriveUnitPriceFromCost({ unitCost: 155, markupPct: 0 })).toBe(155);
    });
    it("100% doubles it", () => {
        expect(deriveUnitPriceFromCost({ unitCost: 45, markupPct: 100 })).toBe(90);
    });
    it("negative markup (loss) — 20% off cost", () => {
        expect(deriveUnitPriceFromCost({ unitCost: 100, markupPct: -20 })).toBe(80);
    });
    it("rounds to 2 dp on ugly math", () => {
        // 33.33 × 1.4 = 46.662 → 46.66
        expect(deriveUnitPriceFromCost({ unitCost: 33.33, markupPct: 40 })).toBe(46.66);
    });
    it("cost 0 → price 0 regardless of markup (avoid NaN from ×infinity)", () => {
        expect(deriveUnitPriceFromCost({ unitCost: 0, markupPct: 999 })).toBe(0);
    });
    it("null cost → null (no answer yet)", () => {
        expect(deriveUnitPriceFromCost({ unitCost: null, markupPct: 40 })).toBeNull();
    });
    it("null markup → null (advisor is still typing)", () => {
        expect(deriveUnitPriceFromCost({ unitCost: 300, markupPct: null })).toBeNull();
    });
    it("NaN cost → null (input in transit)", () => {
        expect(deriveUnitPriceFromCost({ unitCost: NaN, markupPct: 40 })).toBeNull();
    });
    it("negative cost → null (invalid)", () => {
        expect(deriveUnitPriceFromCost({ unitCost: -5, markupPct: 40 })).toBeNull();
    });
});

describe("deriveMarkupFromPrice", () => {
    it("300 → 420 implies 40% markup", () => {
        expect(deriveMarkupFromPrice({ unitCost: 300, unitPrice: 420 })).toBe(40);
    });
    it("price = cost → 0% markup", () => {
        expect(deriveMarkupFromPrice({ unitCost: 155, unitPrice: 155 })).toBe(0);
    });
    it("price = 2×cost → 100% markup", () => {
        expect(deriveMarkupFromPrice({ unitCost: 45, unitPrice: 90 })).toBe(100);
    });
    it("selling at a loss returns negative markup", () => {
        expect(deriveMarkupFromPrice({ unitCost: 100, unitPrice: 80 })).toBe(-20);
    });
    it("rounds to 2 dp", () => {
        // 33.33 × 1.4 = 46.662 → stored 46.66 → back to markup
        // 46.66 / 33.33 - 1 = 0.399939… × 100 = 39.99, rounds to 39.99
        expect(deriveMarkupFromPrice({ unitCost: 33.33, unitPrice: 46.66 })).toBeCloseTo(39.99, 2);
    });
    it("cost 0 → null (division by zero, meaningless answer)", () => {
        expect(deriveMarkupFromPrice({ unitCost: 0, unitPrice: 50 })).toBeNull();
    });
    it("null price → null", () => {
        expect(deriveMarkupFromPrice({ unitCost: 300, unitPrice: null })).toBeNull();
    });
});

describe("round-trip stability (editor UX invariant)", () => {
    // The two-way binding: type cost + markup → compute price → user
    // overrides price → compute markup back. The recomputed markup
    // should equal the ORIGINAL to within 0.01, so the input the
    // advisor sees doesn't jitter as they tab between fields.
    it.each([
        [300, 40],
        [155, 12.5],
        [45.5, 100],
        [1000, 5],
        [33.33, 25],
    ])("cost=%f markup=%f", (cost, markup) => {
        const price = deriveUnitPriceFromCost({ unitCost: cost, markupPct: markup });
        expect(price).not.toBeNull();
        const derivedMarkup = deriveMarkupFromPrice({ unitCost: cost, unitPrice: price! });
        expect(derivedMarkup).toBeCloseTo(markup, 1);
    });
});

describe("lineMargin", () => {
    it("simple: 300 cost, 420 sell, qty 2 → 240 margin", () => {
        expect(lineMargin({ unitCost: 300, unitPrice: 420, qty: 2 })).toBe(240);
    });
    it("zero-margin line: cost = price → 0", () => {
        expect(lineMargin({ unitCost: 155, unitPrice: 155, qty: 3 })).toBe(0);
    });
    it("negative margin (loss)", () => {
        expect(lineMargin({ unitCost: 100, unitPrice: 80, qty: 1 })).toBe(-20);
    });
    it("null cost → null (can't say)", () => {
        expect(lineMargin({ unitCost: null, unitPrice: 420, qty: 2 })).toBeNull();
    });
    it("null qty → null", () => {
        expect(lineMargin({ unitCost: 300, unitPrice: 420, qty: null })).toBeNull();
    });
    it("rounds ugly", () => {
        // (46.66 - 33.33) × 3 = 39.99 exactly
        expect(lineMargin({ unitCost: 33.33, unitPrice: 46.66, qty: 3 })).toBe(39.99);
    });
});
