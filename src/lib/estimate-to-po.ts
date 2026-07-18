// Estimate → Purchase Order helpers. Two pure functions the "Convert from
// estimate" flow depends on, extracted so they can be unit-tested without
// touching Prisma. See docs/Estimate-to-PO-Spec.md for the locked rules.
//
// 1. pickEstimateForConversion — a job has many estimates (revisions).
//    Choose the right one to convert, following the locked selection rule:
//    APPROVED (latest by approvedAt) > SENT (latest by sentAt).
//    Never DRAFT (would leak internal figures), never REJECTED (customer
//    said no). If none of the estimates are usable, surface that with
//    enough context to render a helpful message.
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
export interface EstimateForPick {
    id: string;
    status: EstimateStatus;
    approvedAt: Date | null;
    sentAt: Date | null;
}

export interface EstimateLineForFilter {
    id: string;
    kind: LineKind;
    partId: string | null;
    declined: boolean;
}

export type EstimatePickResult<E extends EstimateForPick> =
    | { kind: "picked"; estimate: E; reason: "approved" | "sent" }
    | { kind: "none-usable"; totalCount: number }
    | { kind: "no-estimate" };

export function pickEstimateForConversion<E extends EstimateForPick>(
    estimates: E[],
): EstimatePickResult<E> {
    if (estimates.length === 0) return { kind: "no-estimate" };

    // APPROVED wins. Filter also demands approvedAt is set — a row with
    // status=APPROVED and null approvedAt is malformed data (the schema
    // doesn't enforce paired writes) and shouldn't be picked without a
    // tie-break timestamp.
    const approved = estimates.filter(
        (e) => e.status === "APPROVED" && e.approvedAt !== null,
    );
    if (approved.length > 0) {
        // Latest by approvedAt. Non-null guaranteed by the filter above.
        const latest = approved.reduce((a, b) =>
            a.approvedAt!.getTime() >= b.approvedAt!.getTime() ? a : b,
        );
        return { kind: "picked", estimate: latest, reason: "approved" };
    }

    const sent = estimates.filter(
        (e) => e.status === "SENT" && e.sentAt !== null,
    );
    if (sent.length > 0) {
        const latest = sent.reduce((a, b) =>
            a.sentAt!.getTime() >= b.sentAt!.getTime() ? a : b,
        );
        return { kind: "picked", estimate: latest, reason: "sent" };
    }

    // We have estimates, but none are usable — all DRAFT and/or REJECTED
    // (or malformed with null timestamps). Return the total so the UI can
    // say "This job has 2 estimate(s), but none are Approved or Sent yet."
    return { kind: "none-usable", totalCount: estimates.length };
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
