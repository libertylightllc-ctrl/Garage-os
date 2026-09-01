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

/**
 * Three renderable document kinds:
 *   PO       — a committed purchase order (status ORDERED /
 *              PARTIALLY_RECEIVED / RECEIVED, or CANCELLED after a
 *              real order). Title reads "Purchase Order".
 *   PO_DRAFT — a DRAFT the author explicitly created as a purchase
 *              order (intent=ORDER) — prices known up front, but the
 *              owner hasn't clicked Mark Ordered yet so it's still
 *              editable and unsent. Title reads "Purchase Order
 *              (draft)" so nobody thinks it's been committed.
 *   RFQ      — a quotation (DRAFT with intent=QUOTE, or a CANCELLED
 *              row that never made it to ORDERED). Title reads
 *              "Request for Quotation".
 */
export type PoDocKind = "PO" | "PO_DRAFT" | "RFQ";

export type PoStatusForDocKind =
    | "DRAFT"
    | "ORDERED"
    | "PARTIALLY_RECEIVED"
    | "RECEIVED"
    | "CANCELLED";

export type PoIntent = "QUOTE" | "ORDER";

/**
 * Minimum shape needed to classify a PO. `orderedAt` is stamped by
 * setPoStatusAction on the DRAFT → ORDERED transition (see the
 * PurchaseOrder.orderedAt schema comment). Its presence lets a
 * CANCELLED document remember whether it was ever committed.
 * `intent` is optional for backward compatibility with any caller
 * that hasn't been updated to fetch the new column; missing intent is
 * treated as QUOTE (safe default — reads as RFQ while DRAFT).
 */
export interface PoForDocKind {
    status: PoStatusForDocKind;
    orderedAt: Date | null;
    intent?: PoIntent;
}

/** Status + intent classifier. See file header for the rule. */
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
    // DRAFT or CANCELLED-without-orderedAt. Intent decides between
    // "draft purchase order" and "request for quotation".
    if (po.status === "DRAFT" && po.intent === "ORDER") {
        return "PO_DRAFT";
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

// ── Status display (AR 2026-08-16) ─────────────────────────────────
//
// A DRAFT PurchaseOrder that has ALREADY been sent to a supplier
// reads as "Draft" — technically right (nothing was ordered), but
// operators see "Draft" and think the doc hasn't gone out yet. The
// send audit says otherwise; the label lies by omission.
//
// Split the display into two facts:
//   • Underlying status stays the schema value (Mark Ordered still
//     drives the DRAFT → ORDERED transition — no schema change).
//   • The DISPLAY LABEL considers status + docKind + whether at
//     least one send exists.
//
// Rule:
//   status !== DRAFT               → poStatus_<status> (unchanged)
//   status === DRAFT, sendCount>0
//     kind === RFQ                 → poStatusDraftSent_RFQ
//                                    ("Sent — awaiting quote")
//     kind === PO_DRAFT            → poStatusDraftSent_PO
//                                    ("Sent — awaiting order")
//   status === DRAFT, sendCount=0  → poStatus_DRAFT (unchanged)
//
// The i18n key resolution is left to the caller so this stays a
// pure function. See src/i18n/config.ts for the strings.

export type PoStatusDisplayKey =
    | `poStatus_${PoStatusForDocKind}`
    | "poStatusDraftSent_RFQ"
    | "poStatusDraftSent_PO";

export function poStatusDisplayKey(
    po: PoForDocKind,
    sendCount: number,
): PoStatusDisplayKey {
    if (po.status === "DRAFT" && sendCount > 0) {
        const kind = poDocKind(po);
        // A CANCELLED-with-orderedAt-null still classifies as RFQ but
        // its status isn't DRAFT — the outer guard skips it.
        return kind === "PO_DRAFT"
            ? "poStatusDraftSent_PO"
            : "poStatusDraftSent_RFQ";
    }
    return `poStatus_${po.status}`;
}

// AR 2026-08-30 (bug #2). A PO line has a "receive destination"
// when at least one of these three holds:
//   - partId set          → will stock-in on receive
//   - sourceEstimateLineId → direct-fit via the source estimate → job
//   - vehicleJobNumber    → direct-fit via the line's captured JC#
// A line without ANY of the three CANNOT be received — receive
// refuses because direct-fit needs a job and stock needs a Part. So
// a PO that carries such a line into ORDERED becomes stuck the
// moment it starts receiving. This helper is the invariant that
// setPoStatusAction (DRAFT → ORDERED) and addPoLineAction (on
// DRAFT/ORDER) enforce.
//
// Lives in this module (not in src/app/actions/purchasing.ts) so it
// can be exported alongside the other PO-shape helpers here without
// Next.js rejecting it — Server Actions files ("use server") can
// only export async functions.
export interface LineForDestinationCheck {
    partId: string | null;
    sourceEstimateLineId: string | null;
    vehicleJobNumber: number | null;
}
export function lineHasReceiveDestination(l: LineForDestinationCheck): boolean {
    return l.partId !== null || l.sourceEstimateLineId !== null || l.vehicleJobNumber !== null;
}
