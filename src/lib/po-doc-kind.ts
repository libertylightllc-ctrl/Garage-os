/**
 * Purchase Order vs Request For Quotation — the classifier every
 * PO-shaped surface (internal detail page, print layout, public
 * /c/po/[id] route, WhatsApp/email message body, and the
 * /owner/purchasing/ list) must agree on.
 *
 * Rule (AR's ruling, 2026-08-01, superseding the price-based rule
 * of 2026-07-27):
 *
 *   The document type is decided by whether the owner has committed
 *   to buy — i.e. whether Mark Ordered has been clicked. Entering
 *   supplier-quoted prices on a DRAFT does NOT flip the label to PO.
 *   That click is the ONLY thing that turns a quotation into an
 *   order.
 *
 *     DRAFT                                    → RFQ
 *     ORDERED / PARTIALLY_RECEIVED / RECEIVED  → PO
 *     CANCELLED with orderedAt set             → PO
 *       (was committed pre-cancel; a supplier who received it and
 *        may have shipped against it must not see the doc retitled
 *        as a quotation)
 *     CANCELLED with orderedAt null            → RFQ
 *       (never committed)
 *
 *   Line prices are ONLY used by `canMarkOrdered` — the guard that
 *   blocks Mark Ordered while any line is still awaiting a quote.
 *
 * Kept as pure functions so tests, server-render surfaces, and
 * client components can all import it.
 */

export type PoDocKind = "PO" | "RFQ";

export type PoStatusForDocKind =
    | "DRAFT"
    | "ORDERED"
    | "PARTIALLY_RECEIVED"
    | "RECEIVED"
    | "CANCELLED";

/**
 * Minimum shape needed to classify a PO. `orderedAt` is stamped by
 * setPoStatusAction on the DRAFT → ORDERED transition (see the
 * PurchaseOrder.orderedAt schema comment). Its presence lets a
 * CANCELLED document remember whether it was ever committed.
 */
export interface PoForDocKind {
    status: PoStatusForDocKind;
    orderedAt: Date | null;
}

/** Status-based classifier. See file header for the rule. */
export function poDocKind(po: PoForDocKind): PoDocKind {
    if (
        po.status === "ORDERED" ||
        po.status === "PARTIALLY_RECEIVED" ||
        po.status === "RECEIVED"
    ) {
        return "PO";
    }
    if (po.status === "CANCELLED" && po.orderedAt !== null) {
        return "PO";
    }
    return "RFQ";
}

/**
 * Priced = a supplier price has landed on the line. Includes 0 —
 * a supplier warranty replacement or courtesy line is a valid order
 * at zero cost. Excludes NULL (quote hasn't arrived) plus every
 * non-numeric bag of bits Number() would silently coerce to 0:
 * "", "   ", empty arrays, booleans, plain objects. Only accept
 * things that a caller would reasonably STORE as a Decimal.
 *
 * The naive `Number(x) >= 0 && isFinite(Number(x))` reads `""` as 0
 * (Number("") is 0) and would silently treat a blank input as a
 * priced zero-cost line. The type-guarded pre-check catches that
 * before coercion.
 */
export interface LineForOrderGuard {
    unitCost: unknown;
}

/** Inverse of `isLinePriced` — a line whose `unitCost` has not yet
 * landed (or is otherwise a not-storable-as-Decimal value). Exposed
 * as its own export so surface code reads naturally: the RFQ table
 * asks "is this line unpriced?" per row to decide whether to render
 * a dash + "quote please" tag instead of a formatted currency. */
export function isLineUnpriced(l: LineForOrderGuard): boolean {
    return !isLinePriced(l);
}

export function isLinePriced(l: LineForOrderGuard): boolean {
    const raw = l.unitCost;
    if (raw === null || raw === undefined) return false;

    if (typeof raw === "number") {
        return Number.isFinite(raw) && raw >= 0;
    }

    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed === "") return false;
        const n = Number(trimmed);
        return Number.isFinite(n) && n >= 0;
    }

    // Prisma.Decimal or any object with a non-empty string form. Reject
    // arrays and plain {} whose toString() would coerce to "" or "[object]".
    if (typeof raw === "object") {
        // Arrays: `Number([])` is 0 and `Number([5])` is 5 — both are
        // wrong shapes to accept as a price. Reject the array shape.
        if (Array.isArray(raw)) return false;
        const s = String(raw).trim();
        if (s === "" || s === "[object Object]") return false;
        const n = Number(s);
        return Number.isFinite(n) && n >= 0;
    }

    return false;
}

/**
 * Guard for setPoStatusAction's DRAFT → ORDERED transition. Cannot
 * commit while any line is still awaiting a quote. Empty PO is
 * rejected (same rule as today). Zero-cost lines are admitted — a
 * supplier warranty replacement is a real order.
 */
export function canMarkOrdered(lines: readonly LineForOrderGuard[]): boolean {
    if (lines.length === 0) return false;
    return lines.every(isLinePriced);
}
