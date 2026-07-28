/**
 * Purchase Order vs Request For Quotation — the classifier every
 * PO-shaped surface (internal page, print layout, public /c/po/[id]
 * route, WhatsApp/email message body, and the /owner/purchasing/
 * from-estimate conversion screen) must agree on.
 *
 * Rule (AR's ruling, 2026-07-27):
 *   - A document with EVERY line priced (unitCost > 0 and finite)
 *     is a Purchase Order. Only then is the shop committing to a
 *     specific price.
 *   - A document with ANY unpriced line (0, negative, NaN, or
 *     otherwise not-a-positive-finite-number) is a Request For
 *     Quotation. The supplier fills in what's missing.
 *   - An empty document (zero lines) defaults to RFQ. Nothing has
 *     been priced, so calling it a PO is the more dangerous label
 *     — fail toward asking rather than committing.
 *
 * `Number.isFinite(n) && n > 0` is the explicit "priced" test:
 *   - Negative → not priced. Reads as RFQ. (A negative supplier cost
 *     shouldn't happen; if it did, treat it as data to be quoted
 *     rather than a real commitment.)
 *   - NaN (Number("") on an empty/invalid unitCost string) → not
 *     priced. Reads as RFQ. Same defensive posture.
 *   - `isLineUnpriced` is the exact logical complement so a NaN or
 *     negative line does NOT sneak into "priced" rendering while
 *     silently flipping the document to RFQ.
 *
 * Kept as pure functions with a narrow input shape so tests and
 * server-render surfaces and client components can all import it.
 */

export type PoDocKind = "PO" | "RFQ";

/** Shape a caller must provide per line — accepts Prisma.Decimal, number, or numeric string. */
export interface LineForDocKind {
    unitCost: unknown;
}

/**
 * True when the line has a specific, positive, finite price the shop
 * is committing to. Any other value (0, negative, NaN, undefined,
 * unparseable string) → unpriced.
 */
export function isLinePriced(l: LineForDocKind): boolean {
    const n = Number(l.unitCost);
    return Number.isFinite(n) && n > 0;
}

/** Exact complement of `isLinePriced`. */
export function isLineUnpriced(l: LineForDocKind): boolean {
    return !isLinePriced(l);
}

/**
 * Classify the document. Empty defaults to RFQ (see file comment).
 */
export function poDocKind(lines: readonly LineForDocKind[]): PoDocKind {
    if (lines.length === 0) return "RFQ";
    return lines.every(isLinePriced) ? "PO" : "RFQ";
}
