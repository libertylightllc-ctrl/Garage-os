/**
 * Unit tests for estimate-sections shape rules. Pins the assignment
 * rules (Q1 in the Batch C plan) so a future edit can't silently
 * reshape which lines land in which section. AR 2026-08-25 Batch C.
 */

import { describe, it, expect } from "vitest";
import { sectionFor, groupLinesBySection, type SectionedLine } from "@/lib/estimate-sections";

function line(overrides: Partial<SectionedLine>): SectionedLine {
    return {
        kind: "PART", description: "x", qty: 1, unitPrice: 100, lineTotal: 100,
        declined: false, ...overrides,
    };
}

describe("sectionFor — kind + unitPrice → section", () => {
    it("PART → parts (regardless of unitPrice sign, though negative parts are rare)", () => {
        expect(sectionFor("PART", 100)).toBe("parts");
        expect(sectionFor("PART", 0)).toBe("parts");
    });

    it("SUBLET → sublet (the new bucket)", () => {
        expect(sectionFor("SUBLET", 250)).toBe("sublet");
    });

    it("LABOR → labour (regardless of price)", () => {
        expect(sectionFor("LABOR", 500)).toBe("labour");
        expect(sectionFor("LABOR", 0)).toBe("labour");
    });

    it("FEE positive → sublet (compat bucket for pre-Batch-C rows)", () => {
        expect(sectionFor("FEE", 200)).toBe("sublet");
    });

    it("FEE zero → sublet (edge; a zero FEE is degenerate but not a discount)", () => {
        expect(sectionFor("FEE", 0)).toBe("sublet");
    });

    it("FEE negative → discount (existing convention for goodwill deductions)", () => {
        expect(sectionFor("FEE", -100)).toBe("discount");
        expect(sectionFor("FEE", -0.01)).toBe("discount");
    });
});

describe("groupLinesBySection — full estimate", () => {
    it("groups every non-declined line into the right section with correct subtotals", () => {
        const lines: SectionedLine[] = [
            line({ kind: "PART",   description: "Brake pad",   lineTotal: 300 }),
            line({ kind: "PART",   description: "Rotor",       lineTotal: 500 }),
            line({ kind: "SUBLET", description: "Wheel align", lineTotal: 200 }),
            line({ kind: "LABOR",  description: "Fit brakes",  lineTotal: 150 }),
            line({ kind: "LABOR",  description: "Test drive",  lineTotal: 100 }),
            line({ kind: "FEE",    description: "Shop consumables", unitPrice: 50, lineTotal: 50 }),
            line({ kind: "FEE",    description: "Goodwill discount", unitPrice: -100, lineTotal: -100 }),
        ];
        const g = groupLinesBySection(lines);
        expect(g.parts.subtotal).toBe(800);
        expect(g.sublet.subtotal).toBe(250);   // SUBLET 200 + FEE+ 50
        expect(g.labour.subtotal).toBe(250);   // 150 + 100
        expect(g.discounts.subtotal).toBe(-100);
        expect(g.sumOfSections).toBe(1300);    // 800 + 250 + 250
        expect(g.grossExVat).toBe(1200);       // 1300 − 100
    });

    it("declined lines are skipped entirely — never contribute to any subtotal", () => {
        const lines: SectionedLine[] = [
            line({ kind: "PART",   lineTotal: 300 }),
            line({ kind: "PART",   lineTotal: 500, declined: true }),
            line({ kind: "SUBLET", lineTotal: 200, declined: true }),
        ];
        const g = groupLinesBySection(lines);
        expect(g.parts.subtotal).toBe(300);
        expect(g.parts.lines).toHaveLength(1);
        expect(g.sublet.subtotal).toBe(0);
        expect(g.sublet.lines).toHaveLength(0);
    });

    it("empty estimate → all subtotals 0, all groups empty", () => {
        const g = groupLinesBySection([]);
        expect(g.parts.subtotal).toBe(0);
        expect(g.sublet.subtotal).toBe(0);
        expect(g.labour.subtotal).toBe(0);
        expect(g.discounts.subtotal).toBe(0);
        expect(g.sumOfSections).toBe(0);
        expect(g.grossExVat).toBe(0);
    });

    it("only discounts (edge) → sumOfSections=0, grossExVat=negative", () => {
        const lines: SectionedLine[] = [
            line({ kind: "FEE", unitPrice: -50, lineTotal: -50 }),
        ];
        const g = groupLinesBySection(lines);
        expect(g.sumOfSections).toBe(0);
        expect(g.grossExVat).toBe(-50);
    });

    it("rounding — subtotals rounded to 2dp even when input floats are messy", () => {
        const lines: SectionedLine[] = [
            line({ kind: "PART", lineTotal: 100.10 }),
            line({ kind: "PART", lineTotal: 100.20 }),
            line({ kind: "PART", lineTotal: 100.30 }),
        ];
        const g = groupLinesBySection(lines);
        // JS floats: 100.10 + 100.20 + 100.30 = 300.5999999...; must round to 300.60.
        expect(g.parts.subtotal).toBe(300.60);
    });
});
