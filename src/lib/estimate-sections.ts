/**
 * Estimate sections (AR 2026-08-25 Batch C).
 *
 * Group estimate lines into the three sections a real UAE shop's
 * estimate document uses:
 *   1. Parts — physical parts
 *   2. Sublet / Consumables / Services — outside work + consumables
 *   3. Labour — the shop's own labour
 *
 * Then discount lines (FEE with negative unitPrice) apply after the
 * three subtotals but before gross/VAT/net.
 *
 * Mapping rules — pure display-time logic; no schema knowledge
 * beyond kind + unitPrice sign:
 *
 *   | kind    | unitPrice | Section                                |
 *   | PART    | any       | Parts                                  |
 *   | SUBLET  | any       | Sublet / Consumables / Services        |
 *   | FEE     | > 0       | Sublet / Consumables / Services (compat) |
 *   | FEE     | < 0       | Discount (rendered after subtotals)    |
 *   | FEE     | = 0       | Sublet / Consumables / Services (edge) |
 *   | LABOR   | any       | Labour                                 |
 *
 * FEE-positive routes to Sublet as a compatibility bridge for
 * pre-Batch-C rows that captured "wheel alignment" style entries
 * under FEE. New rows should use SUBLET. FEE stays valid for
 * one-off charges without a clean sublet fit + for discount lines.
 */

import type { LineKind } from "@/lib/billing";

export type LineSection = "parts" | "sublet" | "labour" | "discount";

export function sectionFor(kind: LineKind, unitPrice: number): LineSection {
    if (kind === "PART") return "parts";
    if (kind === "LABOR") return "labour";
    if (kind === "SUBLET") return "sublet";
    // FEE — split by sign. Negative = discount line (existing
    // convention, see estimate-line-card.tsx). Zero + positive =
    // Sublet/Services (compat bucket).
    if (kind === "FEE") return unitPrice < 0 ? "discount" : "sublet";
    // Exhaustive fallback — future kinds land in Labour rather than
    // being silently dropped from the totals. TypeScript's exhaustive
    // check catches new enum values at compile time; this runtime
    // fallback is defence-in-depth for a schema race where the
    // client is older than the DB.
    return "labour";
}

export interface SectionedLine {
    kind: LineKind;
    description: string;
    qty: number;
    unitPrice: number;
    lineTotal: number;
    declined?: boolean;
}

export interface SectionGroup<T extends SectionedLine> {
    lines: T[];
    subtotal: number;
}

export interface SectionedLines<T extends SectionedLine> {
    parts: SectionGroup<T>;
    sublet: SectionGroup<T>;
    labour: SectionGroup<T>;
    /** Discount lines (FEE with negative unitPrice). Rendered
     *  separately after the three section subtotals. */
    discounts: SectionGroup<T>;
    /** Sum of the three section subtotals — the "before discount"
     *  gross-ex-VAT figure. */
    sumOfSections: number;
    /** sumOfSections + Σ discount lineTotals (which are negative).
     *  The gross-ex-VAT the shop actually charges. */
    grossExVat: number;
}

function group<T extends SectionedLine>(lines: T[]): SectionGroup<T> {
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { lines, subtotal: round2(subtotal) };
}

function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Bucket a set of lines into the four sections. Declined lines are
 * skipped entirely — they never contribute to a subtotal or section
 * (matching how declined lines are rendered on the customer surface
 * today, with a strikethrough but no financial impact).
 */
export function groupLinesBySection<T extends SectionedLine>(
    lines: T[],
): SectionedLines<T> {
    const parts: T[] = [];
    const sublet: T[] = [];
    const labour: T[] = [];
    const discounts: T[] = [];
    for (const l of lines) {
        if (l.declined) continue;
        const s = sectionFor(l.kind, l.unitPrice);
        if (s === "parts") parts.push(l);
        else if (s === "sublet") sublet.push(l);
        else if (s === "labour") labour.push(l);
        else discounts.push(l);
    }
    const pg = group(parts);
    const sg = group(sublet);
    const lg = group(labour);
    const dg = group(discounts);
    const sumOfSections = round2(pg.subtotal + sg.subtotal + lg.subtotal);
    const grossExVat = round2(sumOfSections + dg.subtotal);
    return {
        parts: pg,
        sublet: sg,
        labour: lg,
        discounts: dg,
        sumOfSections,
        grossExVat,
    };
}
