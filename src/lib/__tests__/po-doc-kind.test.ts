import { describe, it, expect } from "vitest";
import { poDocKind, isLinePriced, isLineUnpriced } from "@/lib/po-doc-kind";

describe("isLinePriced / isLineUnpriced", () => {
    it("positive number → priced", () => {
        expect(isLinePriced({ unitCost: 100 })).toBe(true);
        expect(isLineUnpriced({ unitCost: 100 })).toBe(false);
    });

    it("positive numeric string (Prisma Decimal.toString) → priced", () => {
        expect(isLinePriced({ unitCost: "42.50" })).toBe(true);
        expect(isLineUnpriced({ unitCost: "42.50" })).toBe(false);
    });

    it("zero → unpriced", () => {
        expect(isLinePriced({ unitCost: 0 })).toBe(false);
        expect(isLineUnpriced({ unitCost: 0 })).toBe(true);
    });

    it("zero as string → unpriced", () => {
        expect(isLinePriced({ unitCost: "0.00" })).toBe(false);
        expect(isLineUnpriced({ unitCost: "0.00" })).toBe(true);
    });

    it("negative → unpriced (defensive — negatives shouldn't happen, treat as needing a quote)", () => {
        expect(isLinePriced({ unitCost: -5 })).toBe(false);
        expect(isLineUnpriced({ unitCost: -5 })).toBe(true);
    });

    it("NaN (empty / unparseable string) → unpriced (defensive; also complement of priced)", () => {
        expect(isLinePriced({ unitCost: "" })).toBe(false);
        expect(isLineUnpriced({ unitCost: "" })).toBe(true);
        expect(isLinePriced({ unitCost: "abc" })).toBe(false);
        expect(isLineUnpriced({ unitCost: "abc" })).toBe(true);
    });

    it("undefined / null → unpriced", () => {
        expect(isLinePriced({ unitCost: undefined })).toBe(false);
        expect(isLineUnpriced({ unitCost: undefined })).toBe(true);
        expect(isLinePriced({ unitCost: null })).toBe(false);
        expect(isLineUnpriced({ unitCost: null })).toBe(true);
    });

    it("Infinity → unpriced (Number.isFinite guard)", () => {
        expect(isLinePriced({ unitCost: Infinity })).toBe(false);
        expect(isLineUnpriced({ unitCost: Infinity })).toBe(true);
    });

    it("isLineUnpriced is the exact logical complement of isLinePriced", () => {
        // The whole "quote please" marker rendering depends on this:
        // a NaN line must both flip the doc to RFQ AND be tagged
        // "please quote"; if the two predicates disagreed, a NaN
        // line would flip the doc but render as if priced, which is
        // the specific bug the complement contract prevents.
        const cases = [0, 1, -1, NaN, Infinity, -Infinity, "", "0", "1", "abc", null, undefined];
        for (const c of cases) {
            expect(isLineUnpriced({ unitCost: c })).toBe(!isLinePriced({ unitCost: c }));
        }
    });
});

describe("poDocKind", () => {
    it("empty document → RFQ (defensive default; fail toward asking rather than committing)", () => {
        expect(poDocKind([])).toBe("RFQ");
    });

    it("all lines priced → PO", () => {
        expect(poDocKind([{ unitCost: 10 }, { unitCost: 20 }, { unitCost: 30 }])).toBe("PO");
    });

    it("all lines zero → RFQ (the classic 'shop has no prices yet' case)", () => {
        expect(poDocKind([{ unitCost: 0 }, { unitCost: 0 }, { unitCost: 0 }])).toBe("RFQ");
    });

    it("mixed pricing — ANY unpriced line → RFQ (AR's ruling, 2026-07-27)", () => {
        // Even one 0.00 line means we're asking the supplier to fill
        // it in. Calling the document a PO would commit to buying
        // that line at unknown cost.
        expect(poDocKind([{ unitCost: 100 }, { unitCost: 50 }, { unitCost: 0 }])).toBe("RFQ");
        // Order doesn't matter; the position of the unpriced line
        // is not what determines the doc kind.
        expect(poDocKind([{ unitCost: 0 }, { unitCost: 100 }, { unitCost: 50 }])).toBe("RFQ");
    });

    it("mixed with NaN → RFQ (NaN counts as unpriced)", () => {
        expect(poDocKind([{ unitCost: 100 }, { unitCost: "" }])).toBe("RFQ");
    });

    it("mixed with negative → RFQ (negative counts as unpriced)", () => {
        expect(poDocKind([{ unitCost: 100 }, { unitCost: -5 }])).toBe("RFQ");
    });

    it("string prices (Prisma Decimal serialized) — all-positive → PO", () => {
        expect(poDocKind([{ unitCost: "100.00" }, { unitCost: "50.25" }])).toBe("PO");
    });
});
