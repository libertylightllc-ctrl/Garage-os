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
//    (LABOR, PART, FEE). Only PART lines that (a) link to an inventory
//    Part and (b) weren't declined by the customer can flow into a PO,
//    because PurchaseOrderLine.partId is required in the schema. Return
//    the convertible set plus the skipped groups so the UI can show
//    "3 of 5 parts — 2 skipped, needs inventory link" etc.

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
    skippedNoPartId: L[];
    skippedDeclined: L[];
}

export function filterConvertibleLines<L extends EstimateLineForFilter>(
    lines: L[],
): FilteredLines<L> {
    const convertible: L[] = [];
    const skippedNoPartId: L[] = [];
    const skippedDeclined: L[] = [];

    for (const l of lines) {
        // LABOR and FEE never go to a PO. Silently drop — not "skipped"
        // from the owner's perspective, they just aren't parts.
        if (l.kind !== "PART") continue;

        // Declined checked BEFORE partId — a declined line without a
        // partId is still fundamentally "customer said no", and that's
        // the more helpful message than "add to inventory first".
        if (l.declined) {
            skippedDeclined.push(l);
            continue;
        }

        if (l.partId === null) {
            skippedNoPartId.push(l);
            continue;
        }

        convertible.push(l);
    }

    return { convertible, skippedNoPartId, skippedDeclined };
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
 * Empty input, or all-punctuation, returns `""` — the caller then
 * routes to [[nextAutoSku]] for an `AUTO-N` fallback.
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
 * Next-free `AUTO-N` SKU for a garage. `AUTO-1` unused → returns
 * `AUTO-1`. Otherwise walks `AUTO-2`, `AUTO-3`, … until one isn't
 * taken. Loop is bounded by `takenSkus.size + 1` so it always
 * terminates.
 *
 * Called when [[slugifyToSku]] returns `""` — the description has
 * no letters/digits (empty, all punctuation, or emoji-only). The
 * `AUTO-N` prefix also reads as an honest marker on the inventory
 * list: "we made this up, you probably want to rename it."
 */
export function nextAutoSku(takenSkus: Set<string>): string {
    const ceiling = takenSkus.size + 2;
    for (let i = 1; i <= ceiling; i++) {
        const candidate = `AUTO-${i}`;
        if (!takenSkus.has(candidate)) return candidate;
    }
    throw new Error("AUTO-N runaway");
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
