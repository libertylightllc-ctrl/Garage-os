import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { resolveInvoiceLineCost } from "@/lib/invoice-cost-snapshot";

// AR 2026-08-12 — pins the corrected snapshot rule. See the helper's
// header for the reasoning; the tests below are the failure modes
// that would break realized-margin reports if the rule ever regressed.

function D(v: string | number): Prisma.Decimal {
    return new Prisma.Decimal(v);
}

describe("resolveInvoiceLineCost — catalog part lines", () => {
    it("uses live Part.cost when the map has an entry, ignoring the estimate's stale unitCost", () => {
        // Advisor priced the estimate line when Part.cost was 100.
        // Between approval and invoicing, a PO landed at 120; the
        // weighted-average blend moved Part.cost to 110. The invoice
        // must freeze 110, not 100.
        const map = new Map([["part-a", D("110.00")]]);
        const out = resolveInvoiceLineCost(
            { partId: "part-a", unitCost: D("100.00") },
            map,
        );
        expect(out?.equals(D("110.00"))).toBe(true);
    });

    it("live cost of zero stays zero — does not fall back to estimate's non-zero value", () => {
        // Shop deliberately holds a zero-cost placeholder (never
        // received), or the seed value is 0. The estimate happens to
        // carry a non-zero guess from the advisor. Freezing the
        // guess would misrepresent the shop's real cost, so zero wins.
        const map = new Map([["part-a", D("0.00")]]);
        const out = resolveInvoiceLineCost(
            { partId: "part-a", unitCost: D("50.00") },
            map,
        );
        expect(out?.equals(D("0.00"))).toBe(true);
    });

    it("falls back to estimate's unitCost when the map has no entry for the partId", () => {
        // Defensive: the map should always cover every partId the
        // caller built it from, but if a part was deleted between
        // fetch and use, we don't want a null-crash — degrade to the
        // estimate snapshot.
        const map = new Map<string, Prisma.Decimal>();
        const out = resolveInvoiceLineCost(
            { partId: "part-missing", unitCost: D("42.00") },
            map,
        );
        expect(out?.equals(D("42.00"))).toBe(true);
    });
});

describe("resolveInvoiceLineCost — free-text lines (no partId)", () => {
    it("returns the estimate's stored unitCost unchanged", () => {
        // Free-text line: nothing in the catalog to look up. The
        // advisor's captured cost is the only source of truth.
        const map = new Map<string, Prisma.Decimal>();
        const out = resolveInvoiceLineCost(
            { partId: null, unitCost: D("35.50") },
            map,
        );
        expect(out?.equals(D("35.50"))).toBe(true);
    });

    it("returns null when the estimate line has no unitCost", () => {
        // Advisor didn't record a cost on a free-text line. The
        // invoice inherits the same null — the profit card will
        // count this line into the Unknown bucket.
        const map = new Map<string, Prisma.Decimal>();
        const out = resolveInvoiceLineCost({ partId: null, unitCost: null }, map);
        expect(out).toBeNull();
    });

    it("ignores map contents when partId is null", () => {
        // Even if some other partId's cost is in the map, a free-text
        // line must not accidentally read it.
        const map = new Map([["part-a", D("999.99")]]);
        const out = resolveInvoiceLineCost(
            { partId: null, unitCost: D("10.00") },
            map,
        );
        expect(out?.equals(D("10.00"))).toBe(true);
    });
});
