// Estimate → Purchase Order helpers. Two pure functions the "Convert from
// estimate" flow depends on, extracted so they can be unit-tested without
// touching Prisma. See docs/Estimate-to-PO-Spec.md for the locked rules.
//
// 1. pickEstimateForConversion — a job has many estimates (revisions).
//    APPROVED / SENT / DRAFT are all usable; REJECTED is not. When zero
//    are usable it's `all-rejected`; when one is usable it's `picked`;
//    when 2+ are usable it's `multiple` and the caller shows a list so
//    the owner explicitly picks one (never auto-pick — an owner may
//    want the old DRAFT over the fresh APPROVED, and silently deciding
//    would hide a real choice). Pass an `estimateId` to select an
//    explicit one out of the usable set (used after the owner clicks a
//    row on the `multiple` list).
//
// 2. filterConvertibleLines — an estimate has lines of every LineKind
//    (LABOR, PART, FEE). Every non-declined PART line can flow into a
//    PO: linked (partId set) writes the PO line with the Part link and
//    the estimate's description as a snapshot; free-text (partId null,
//    Layer 0 schema widen) writes the PO line as description-only with
//    partId null. Nothing writes to the catalogue at any point — the
//    Part row is born at goods receipt (Layer 5), not here.
//
//    Layer 1 (2026-08-02) — free-text lines used to be split off as
//    `skippedNoPartId` because PurchaseOrderLine.partId was NOT NULL.
//    That was the piece that made "send a quotation for a part we
//    don't stock" impossible from this screen. Free-text lines are
//    now in `convertible`; `skippedDeclined` still exists because
//    "customer said no" IS a real skip signal for the reader.

import type { EstimateStatus, LineKind } from "@/generated/prisma/enums";

// Minimal shapes so callers can pass either a full Prisma row or a test
// fixture. If Estimate / EstimateLine schema fields change, the tests +
// call-sites fail loud; this stays narrow on purpose.
// `updatedAt` is the DRAFT tie-break — DRAFT rows have neither
// `approvedAt` nor `sentAt`, so "most recently edited" stands in.
export interface EstimateForPick {
    id: string;
    status: EstimateStatus;
    approvedAt: Date | null;
    sentAt: Date | null;
    updatedAt: Date;
}

export interface EstimateLineForFilter {
    id: string;
    kind: LineKind;
    partId: string | null;
    declined: boolean;
    // Layer 1 (2026-08-02): free-text lines are convertible now, so the
    // description travels with them. Optional on the interface so tests
    // can still construct minimal fixtures.
    description?: string;
}

export type EstimatePickReason = "approved" | "sent" | "draft";

export type EstimatePickResult<E extends EstimateForPick> =
    | { kind: "picked"; estimate: E; reason: EstimatePickReason }
    | { kind: "multiple"; estimates: E[] }
    | { kind: "all-rejected"; totalCount: number }
    | { kind: "no-estimate" };

// Rank inside the multi-list sort — APPROVED first, then SENT, then
// DRAFT. Within the same rank, newer wins (approvedAt / sentAt /
// updatedAt in that order). Used purely for display; picking a single
// one happens explicitly via `estimateId`.
const RANK: Record<"APPROVED" | "SENT" | "DRAFT", number> = {
    APPROVED: 0,
    SENT: 1,
    DRAFT: 2,
};

function isUsable<E extends EstimateForPick>(e: E): boolean {
    if (e.status === "APPROVED") return e.approvedAt !== null;
    if (e.status === "SENT") return e.sentAt !== null;
    return e.status === "DRAFT";
    // REJECTED falls through implicitly — never usable.
}

function reasonFor<E extends EstimateForPick>(e: E): EstimatePickReason {
    if (e.status === "APPROVED") return "approved";
    if (e.status === "SENT") return "sent";
    return "draft";
}

function sortUsable<E extends EstimateForPick>(a: E, b: E): number {
    const ra = RANK[a.status as "APPROVED" | "SENT" | "DRAFT"];
    const rb = RANK[b.status as "APPROVED" | "SENT" | "DRAFT"];
    if (ra !== rb) return ra - rb;
    const key = (e: E): Date => e.approvedAt ?? e.sentAt ?? e.updatedAt;
    return +key(b) - +key(a);
}

export function pickEstimateForConversion<E extends EstimateForPick>(
    estimates: E[],
    estimateId?: string,
): EstimatePickResult<E> {
    if (estimates.length === 0) return { kind: "no-estimate" };

    const usable = estimates.filter(isUsable).sort(sortUsable);
    if (usable.length === 0) {
        return { kind: "all-rejected", totalCount: estimates.length };
    }

    // Explicit id selection happens AFTER the usable filter, from this
    // job's set only. Unknown or non-usable id (e.g. a stale link to a
    // now-REJECTED estimate) falls through to the picker list — the
    // owner sees what's actually available.
    if (estimateId) {
        const chosen = usable.find((e) => e.id === estimateId);
        if (chosen) {
            return { kind: "picked", estimate: chosen, reason: reasonFor(chosen) };
        }
    }

    if (usable.length === 1) {
        return { kind: "picked", estimate: usable[0], reason: reasonFor(usable[0]) };
    }
    return { kind: "multiple", estimates: usable };
}

export interface FilteredLines<L extends EstimateLineForFilter> {
    convertible: L[];
    skippedDeclined: L[];
}

/**
 * Layer 1 (2026-08-02): every non-declined PART line is convertible,
 * whether it has a partId link or not. Free-text lines flow onto the
 * PO with partId null + description set — the schema's row-level
 * CHECK ("partId OR description") is satisfied by the description
 * alone.
 *
 * LABOR and FEE lines are still silently dropped — they can't be
 * ordered from a parts supplier. Declined PART lines go to
 * `skippedDeclined` so the UI can render "customer said no to N
 * items — not on the PO" (still a real signal to the reader; the
 * partId=null split is not).
 */
export function filterConvertibleLines<L extends EstimateLineForFilter>(
    lines: L[],
): FilteredLines<L> {
    const convertible: L[] = [];
    const skippedDeclined: L[] = [];

    for (const l of lines) {
        // LABOR and FEE never go to a PO. Silently drop — not "skipped"
        // from the owner's perspective, they just aren't parts.
        if (l.kind !== "PART") continue;

        if (l.declined) {
            skippedDeclined.push(l);
            continue;
        }

        // Both linked (partId set) and free-text (partId null) lines
        // land here. The action writes description verbatim and only
        // verifies the catalogue Part row when partId is non-null.
        convertible.push(l);
    }

    return { convertible, skippedDeclined };
}

// ── Auto-create Part from free-text estimate line ─────────────────
//
// When `filterConvertibleLines` yields `skippedNoPartId`, the owner
// can now create catalog Parts from those free-text lines so the PO
// can proceed. Three pure helpers back the review UI, extracted so
// they can be unit-tested without touching Prisma.

/**
 * Slugify a free-text description into a candidate SKU.
 *
 *   "Front brake pads (OEM)"  → "FRONT-BRAKE-PADS"
 *   "Suspension bushes set"   → "SUSPENSION-BUSHES-SET"
 *   "  brake pads  "          → "BRAKE-PADS"
 *   "!!!"                     → ""
 *
 * SKUs get read off a shelf and typed into search — the default has to
 * be short and pronounceable, not a slug of a whole sentence. We take
 * the FIRST 3 non-empty tokens, uppercased, joined with `-`. That
 * matches the seed-SKU shape (`OIL-5W30`, `BAT-70AH`, `BRK-PAD-F`).
 * Empty input, or all-punctuation, returns `""` — the caller decides
 * what to do with that (originally the auto-Part-create flow used
 * `AUTO-N`; that flow was removed 2026-08-02, and the `nextAutoSku` /
 * `computeSkuChoice` helpers were deleted 2026-08-13 with it).
 *
 * Edge case: hyphenated part codes like `5W-30` get split into `5W`
 * and `30` (both non-alphanumeric-delimited tokens). We chose this
 * because the alternative — treating `-` as intra-token — messes up
 * far more common cases (`AC — gas top-up`, `brake-pads`). Owner
 * edits the field anyway if the shop's convention is `OIL-5W30`.
 */
export function slugifyToSku(description: string): string {
    const tokens = description
        .toUpperCase()
        .normalize("NFKD")
        .split(/[^A-Z0-9]+/)
        .filter((t) => t.length > 0)
        .slice(0, 3);
    return tokens.join("-");
}

/**
 * Given a base SKU and the set of SKUs already used in this garage,
 * return the first collision-free suffix. `"BAT-70AH"` unused →
 * `"BAT-70AH"`. Already used → `"BAT-70AH-2"`, then `"BAT-70AH-3"`,
 * etc. Loop is bounded by `takenSkus.size + 1` so it always
 * terminates.
 */
export function withCollisionSuffix(base: string, takenSkus: Set<string>): string {
    if (!takenSkus.has(base)) return base;
    let i = 2;
    while (takenSkus.has(`${base}-${i}`)) {
        if (i > takenSkus.size + 1) {
            throw new Error(`SKU collision runaway on base ${base}`);
        }
        i++;
    }
    return `${base}-${i}`;
}

/**
 * Normalize a Part name for fuzzy-match "did the owner already add
 * this?" checks. Lowercase, strip punctuation, collapse whitespace.
 *
 *   "Engine oil 5W-30"    → "engine oil 5w 30"
 *   "engine oil (5w30)"   → "engine oil 5w30"
 *   "  Engine  Oil  5W30" → "engine oil 5w30"
 *
 * Matches "typo" cases like `"break pads"` vs `"brake pads"` — those
 * normalize to different strings ("break pads" vs "brake pads") so
 * the suggestion is NOT triggered. That's a real limit — the review
 * UI will log the normalized pair when a suggestion IS fired so we
 * can measure whether normalize-only is enough or we need trigram
 * fuzzy match later. Log-and-observe before adding fuzzy — AR's rule.
 */
export function normalizePartName(name: string): string {
    return name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Find existing Parts whose normalized name matches the normalized
 * description of a free-text line. Returns the first match (there
 * should be at most one under `@@unique([garageId, sku])` but we
 * accept many just in case). Returns null when no match. Caller uses
 * this to render "Looks like your existing X — link, or create new?"
 * in the review UI. NEVER auto-links; always surfaces the choice.
 */
export function findNormalizedMatch<P extends { id: string; name: string; sku: string }>(
    description: string,
    candidates: readonly P[],
): P | null {
    const target = normalizePartName(description);
    if (!target) return null;
    for (const c of candidates) {
        if (normalizePartName(c.name) === target) return c;
    }
    return null;
}

// SkuChoice + computeSkuChoice + nextAutoSku were the review-page
// tagger for the auto-Part-create flow. The flow was removed
// 2026-08-02 (Layer 1 — free-text estimate lines convert to
// description-only PO lines rather than minting a Part). The
// tagger helpers had no live callers after that; deleted 2026-08-13
// with AR after a Prod audit found 7 residual AUTO Parts, all
// created before 2026-08-02, confirming nothing new mints them.
// See docs/auto-create-sku-bump-indicator-spec.md for the design
// they served — kept for history, no code to trip over.

// ── From-estimate cost prefill resolver ───────────────────────────
//
// The /owner/purchasing/from-estimate page prefills the cost input
// on each convertible line. Two data sources hold a cost per line:
//
//   1. Catalogue Part.cost — rolling weighted-average from goods
//      receipts. The freshest number the shop actually paid.
//   2. EstimateLine.unitCost — the advisor's typed supplier cost at
//      pricing time. The ONLY source for free-text lines (no partId).
//
// unitPrice is the customer-facing charge and never prefills a PO
// cost — customer-price minus advisor markup is what we pay the
// supplier, not what we charge the customer.
//
// Priority: catalogue > estimate > blank. Zero on either source
// triggers the fallback, because writing 0 onto a PO would literally
// tell the supplier the price is zero. Same order as the invoice
// generator (see resolveInvoiceLineCost) with one difference: the
// invoice generator treats a zero Part.cost as authoritative because
// at invoice time an un-receipted Part IS zero-cost on the shop's
// books; on a PO we prefer to fall through to the advisor's typed
// value rather than seed the supplier with 0.
//
// Gap history (AR 2026-08-14): the resolver used to be inline in the
// page and never consulted unitCost — for JC-2026-0098's four free-
// text lines the advisor had typed real supplier costs (BEAKE PADS
// 300, BALL JOINTS RH/LH 250, LABOR CHARGES excluded as non-PART)
// and the picker rendered blanks, silently losing the number.

export type FromEstimatePrefillSource = "catalogue" | "estimate" | "none";

export interface FromEstimatePrefillLine {
    /** Number(part.cost) when the estimate line is linked to a catalogue Part; null for free-text lines. */
    partCost: number | null;
    /** Number(estimateLine.unitCost) — the advisor's typed supplier cost; null when the advisor left it blank. */
    unitCost: number | null;
}

export interface FromEstimatePrefill {
    /** The number to write into the cost input, or null for a blank input. */
    value: number | null;
    /** Provenance — surfaced as a per-line label so the owner sees which source fed the prefill. */
    source: FromEstimatePrefillSource;
}

export function resolveFromEstimatePrefill(
    l: FromEstimatePrefillLine,
): FromEstimatePrefill {
    if (l.partCost !== null && l.partCost > 0) {
        return { value: l.partCost, source: "catalogue" };
    }
    if (l.unitCost !== null && l.unitCost > 0) {
        return { value: l.unitCost, source: "estimate" };
    }
    return { value: null, source: "none" };
}
