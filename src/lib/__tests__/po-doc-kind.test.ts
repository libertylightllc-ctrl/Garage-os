import { describe, it, expect } from "vitest";
import { poDocKind, isLinePriced, isLineUnpriced, canMarkOrdered, poStatusDisplayKey } from "@/lib/po-doc-kind";

describe("isLinePriced", () => {
    it("positive number → priced", () => {
        expect(isLinePriced({ unitCost: 100 })).toBe(true);
    });

    it("positive numeric string (Prisma Decimal.toString) → priced", () => {
        expect(isLinePriced({ unitCost: "42.50" })).toBe(true);
    });

    it("zero → priced (2026-08-01: 0 = quoted-as-no-charge, a warranty replacement or courtesy line)", () => {
        expect(isLinePriced({ unitCost: 0 })).toBe(true);
        expect(isLinePriced({ unitCost: "0.00" })).toBe(true);
    });

    it("null / undefined → unpriced (2026-08-01: null = awaiting a supplier quote)", () => {
        expect(isLinePriced({ unitCost: null })).toBe(false);
        expect(isLinePriced({ unitCost: undefined })).toBe(false);
    });

    it("empty / whitespace string → unpriced (coercion-bug guard: Number('') is 0)", () => {
        // Naive `Number(x) >= 0` would let "" through as a valid 0.
        // The type guard rejects strings that trim to "" before
        // coercion so a blank input is never read as "quoted zero".
        expect(isLinePriced({ unitCost: "" })).toBe(false);
        expect(isLinePriced({ unitCost: "   " })).toBe(false);
        expect(isLinePriced({ unitCost: "\t\n" })).toBe(false);
    });

    it("negative → unpriced (defensive)", () => {
        expect(isLinePriced({ unitCost: -5 })).toBe(false);
        expect(isLinePriced({ unitCost: "-1.00" })).toBe(false);
    });

    it("NaN / Infinity → unpriced", () => {
        expect(isLinePriced({ unitCost: NaN })).toBe(false);
        expect(isLinePriced({ unitCost: Infinity })).toBe(false);
        expect(isLinePriced({ unitCost: -Infinity })).toBe(false);
    });

    it("unparseable string → unpriced", () => {
        expect(isLinePriced({ unitCost: "abc" })).toBe(false);
        expect(isLinePriced({ unitCost: "5abc" })).toBe(false);
    });

    it("array / boolean / plain object → unpriced (all silently coerce to 0 with naive Number())", () => {
        // Number([]) === 0, Number([5]) === 5, Number(false) === 0,
        // Number({}) === NaN. None of these are valid unitCost values.
        expect(isLinePriced({ unitCost: [] })).toBe(false);
        expect(isLinePriced({ unitCost: [5] })).toBe(false);
        expect(isLinePriced({ unitCost: false })).toBe(false);
        expect(isLinePriced({ unitCost: true })).toBe(false);
        expect(isLinePriced({ unitCost: {} })).toBe(false);
    });
});

describe("isLineUnpriced", () => {
    it("is the exact inverse of isLinePriced across the key coercion cases", () => {
        // Every case that pinned isLinePriced above — mirrored, so a
        // future refactor that drifts the two apart trips this test.
        const cases: Array<{ unitCost: unknown }> = [
            { unitCost: 100 },
            { unitCost: "42.50" },
            { unitCost: 0 },
            { unitCost: "0.00" },
            { unitCost: null },
            { unitCost: undefined },
            { unitCost: "" },
            { unitCost: "   " },
            { unitCost: -5 },
            { unitCost: NaN },
            { unitCost: "abc" },
            { unitCost: [] },
            { unitCost: false },
            { unitCost: {} },
        ];
        for (const c of cases) {
            expect(isLineUnpriced(c)).toBe(!isLinePriced(c));
        }
    });
});

describe("canMarkOrdered", () => {
    it("empty document → cannot order (same rule as today)", () => {
        expect(canMarkOrdered([])).toBe(false);
    });

    it("every line priced with positive numbers → can order", () => {
        expect(canMarkOrdered([{ unitCost: 10 }, { unitCost: 20 }])).toBe(true);
    });

    it("zero-cost line admitted — warranty / courtesy lines are real orders", () => {
        expect(canMarkOrdered([{ unitCost: 100 }, { unitCost: 0 }])).toBe(true);
    });

    it("null line → cannot order (still awaiting a supplier quote)", () => {
        expect(canMarkOrdered([{ unitCost: 100 }, { unitCost: null }])).toBe(false);
    });

    it("undefined line → cannot order (defensive)", () => {
        expect(canMarkOrdered([{ unitCost: 100 }, { unitCost: undefined }])).toBe(false);
    });

    it("empty-string line → cannot order (coercion guard; a blank input must not read as zero)", () => {
        expect(canMarkOrdered([{ unitCost: 100 }, { unitCost: "" }])).toBe(false);
    });

    it("negative line → cannot order (defensive)", () => {
        expect(canMarkOrdered([{ unitCost: 100 }, { unitCost: -5 }])).toBe(false);
    });
});

describe("poDocKind", () => {
    const asOf = new Date("2026-08-01T10:00:00Z");

    it("DRAFT + intent=QUOTE → RFQ", () => {
        expect(poDocKind({ status: "DRAFT", orderedAt: null, intent: "QUOTE" })).toBe("RFQ");
    });

    it("DRAFT + intent=ORDER → PO_DRAFT (2026-08-02: 'Purchase Order (draft)')", () => {
        // Author explicitly created this as a purchase order at known
        // prices. Title reads "Purchase Order (draft)" so the reader
        // knows it's uncommitted, but it's not mislabelled as a
        // quotation. Mark Ordered still flips it to plain PO.
        expect(poDocKind({ status: "DRAFT", orderedAt: null, intent: "ORDER" })).toBe("PO_DRAFT");
    });

    it("DRAFT without intent (missing / older rows) → RFQ (safe default)", () => {
        // Backward compatibility: any caller that hasn't been updated
        // to fetch the new column, and any pre-2026-08-02 row whose
        // migration default came through as null via a stale client,
        // reads as RFQ — the safer default (nothing implies committed
        // intent).
        expect(poDocKind({ status: "DRAFT", orderedAt: null })).toBe("RFQ");
    });

    it("ORDERED → PO (intent no longer matters — status governs after commit)", () => {
        expect(poDocKind({ status: "ORDERED", orderedAt: asOf, intent: "QUOTE" })).toBe("PO");
        expect(poDocKind({ status: "ORDERED", orderedAt: asOf, intent: "ORDER" })).toBe("PO");
    });

    it("PARTIALLY_RECEIVED → PO", () => {
        expect(poDocKind({ status: "PARTIALLY_RECEIVED", orderedAt: asOf })).toBe("PO");
    });

    it("RECEIVED → PO", () => {
        expect(poDocKind({ status: "RECEIVED", orderedAt: asOf })).toBe("PO");
    });

    it("CANCELLED without orderedAt + intent=QUOTE → RFQ (never committed)", () => {
        expect(poDocKind({ status: "CANCELLED", orderedAt: null, intent: "QUOTE" })).toBe("RFQ");
    });

    it("CANCELLED without orderedAt + intent=ORDER → still RFQ (status governs after cancel)", () => {
        // Cancelled documents are governed by status + orderedAt, not
        // intent — the author's original intention doesn't survive a
        // cancel. This one never made it to ORDERED so it reads as
        // RFQ regardless of what was originally typed.
        expect(poDocKind({ status: "CANCELLED", orderedAt: null, intent: "ORDER" })).toBe("RFQ");
    });

    it("CANCELLED with orderedAt → PO (was committed; supplier may have shipped)", () => {
        // A supplier who received a PO and may have shipped against
        // it must not see the document retitled as a quotation after
        // the shop cancels — the audit trail should read as
        // "cancelled purchase order", not "cancelled quotation".
        expect(poDocKind({ status: "CANCELLED", orderedAt: asOf })).toBe("PO");
    });
});

describe("poStatusDisplayKey — DRAFT + sends changes label, others unchanged", () => {
    // AR 2026-08-16 rule: a DRAFT that has already been sent to a
    // supplier reads as "Draft" which operators mistake for "not
    // sent". Display flips to "Sent — awaiting quote/order" once
    // any send exists. Underlying status stays DRAFT (Mark Ordered
    // is still the commitment).

    it("DRAFT with zero sends → poStatus_DRAFT (unchanged, 'Draft')", () => {
        expect(
            poStatusDisplayKey(
                { status: "DRAFT", orderedAt: null, intent: "QUOTE" },
                0,
            ),
        ).toBe("poStatus_DRAFT");
    });

    it("DRAFT + intent=QUOTE + at least one send → 'Sent — awaiting quote'", () => {
        expect(
            poStatusDisplayKey(
                { status: "DRAFT", orderedAt: null, intent: "QUOTE" },
                1,
            ),
        ).toBe("poStatusDraftSent_RFQ");
    });

    it("DRAFT + intent=ORDER + at least one send → 'Sent — awaiting order'", () => {
        // A PO_DRAFT (author knew the prices at doc creation) that
        // went to the supplier before Mark Ordered fires the PO
        // version of the awaiting label — the shop is waiting for
        // the supplier to confirm the order, not to quote it.
        expect(
            poStatusDisplayKey(
                { status: "DRAFT", orderedAt: null, intent: "ORDER" },
                1,
            ),
        ).toBe("poStatusDraftSent_PO");
    });

    it("ORDERED with sends → poStatus_ORDERED (post-DRAFT statuses unchanged)", () => {
        expect(
            poStatusDisplayKey(
                { status: "ORDERED", orderedAt: new Date(), intent: "ORDER" },
                3,
            ),
        ).toBe("poStatus_ORDERED");
    });

    it("PARTIALLY_RECEIVED unchanged regardless of send count", () => {
        expect(
            poStatusDisplayKey(
                { status: "PARTIALLY_RECEIVED", orderedAt: new Date(), intent: "ORDER" },
                5,
            ),
        ).toBe("poStatus_PARTIALLY_RECEIVED");
    });

    it("CANCELLED unchanged even with sends (nothing left awaiting)", () => {
        // Explicit — after cancel, the display shouldn't imply the
        // supplier owes anything. "Cancelled" is the whole story.
        expect(
            poStatusDisplayKey(
                { status: "CANCELLED", orderedAt: null, intent: "QUOTE" },
                2,
            ),
        ).toBe("poStatus_CANCELLED");
        expect(
            poStatusDisplayKey(
                { status: "CANCELLED", orderedAt: new Date(), intent: "ORDER" },
                2,
            ),
        ).toBe("poStatus_CANCELLED");
    });
});
