import { describe, it, expect } from "vitest";
import {
    pickEstimateForConversion,
    filterConvertibleLines,
    type EstimateForPick,
    type EstimateLineForFilter,
} from "@/lib/estimate-to-po";

// Fixture builders — narrow, deterministic, easy to skim in a failing test.
function est(
    id: string,
    status: EstimateForPick["status"],
    opts: Partial<Pick<EstimateForPick, "approvedAt" | "sentAt">> = {},
): EstimateForPick {
    return {
        id,
        status,
        approvedAt: opts.approvedAt ?? null,
        sentAt: opts.sentAt ?? null,
    };
}
const T = (iso: string) => new Date(iso);

function line(
    id: string,
    kind: EstimateLineForFilter["kind"],
    opts: Partial<Pick<EstimateLineForFilter, "partId" | "declined">> = {},
): EstimateLineForFilter {
    return {
        id,
        kind,
        partId: opts.partId ?? null,
        declined: opts.declined ?? false,
    };
}

describe("pickEstimateForConversion", () => {
    it("no estimates → no-estimate", () => {
        expect(pickEstimateForConversion([])).toEqual({ kind: "no-estimate" });
    });

    it("only a DRAFT → none-usable with count", () => {
        const r = pickEstimateForConversion([est("d1", "DRAFT")]);
        expect(r).toEqual({ kind: "none-usable", totalCount: 1 });
    });

    it("only a REJECTED → none-usable", () => {
        const r = pickEstimateForConversion([est("r1", "REJECTED")]);
        expect(r).toEqual({ kind: "none-usable", totalCount: 1 });
    });

    it("only a SENT (with sentAt) → picked, reason=sent", () => {
        const s = est("s1", "SENT", { sentAt: T("2026-07-10") });
        const r = pickEstimateForConversion([s]);
        expect(r).toEqual({ kind: "picked", estimate: s, reason: "sent" });
    });

    it("only an APPROVED (with approvedAt) → picked, reason=approved", () => {
        const a = est("a1", "APPROVED", { approvedAt: T("2026-07-10") });
        const r = pickEstimateForConversion([a]);
        expect(r).toEqual({ kind: "picked", estimate: a, reason: "approved" });
    });

    it("APPROVED beats SENT even when SENT is more recent", () => {
        const a = est("a1", "APPROVED", { approvedAt: T("2026-07-01") });
        const s = est("s1", "SENT", { sentAt: T("2026-07-15") });
        const r = pickEstimateForConversion([s, a]);
        expect(r.kind).toBe("picked");
        if (r.kind !== "picked") throw new Error("unreachable");
        expect(r.reason).toBe("approved");
        expect(r.estimate.id).toBe("a1");
    });

    it("two APPROVED → picks the later approvedAt", () => {
        const early = est("a-early", "APPROVED", { approvedAt: T("2026-07-01") });
        const late = est("a-late", "APPROVED", { approvedAt: T("2026-07-15") });
        const r = pickEstimateForConversion([early, late]);
        expect(r.kind).toBe("picked");
        if (r.kind !== "picked") throw new Error("unreachable");
        expect(r.estimate.id).toBe("a-late");
    });

    it("REJECTED + SENT → picks SENT", () => {
        const s = est("s1", "SENT", { sentAt: T("2026-07-10") });
        const rej = est("r1", "REJECTED");
        const r = pickEstimateForConversion([rej, s]);
        expect(r.kind).toBe("picked");
        if (r.kind !== "picked") throw new Error("unreachable");
        expect(r.estimate.id).toBe("s1");
        expect(r.reason).toBe("sent");
    });

    it("DRAFT + REJECTED (no SENT/APPROVED) → none-usable, total 2", () => {
        const r = pickEstimateForConversion([est("d", "DRAFT"), est("r", "REJECTED")]);
        expect(r).toEqual({ kind: "none-usable", totalCount: 2 });
    });

    it("APPROVED with null approvedAt is malformed — skipped (falls to SENT)", () => {
        // Row with status APPROVED but no approvedAt is malformed data
        // (writes happen through the estimate flow which sets both). Don't
        // pick it — falling back to a properly-stamped SENT is safer than
        // guessing a tie-break.
        const bad = est("a-bad", "APPROVED"); // no approvedAt
        const s = est("s1", "SENT", { sentAt: T("2026-07-10") });
        const r = pickEstimateForConversion([bad, s]);
        expect(r.kind).toBe("picked");
        if (r.kind !== "picked") throw new Error("unreachable");
        expect(r.estimate.id).toBe("s1");
        expect(r.reason).toBe("sent");
    });
});

describe("filterConvertibleLines", () => {
    it("empty list → all buckets empty", () => {
        const r = filterConvertibleLines([]);
        expect(r).toEqual({ convertible: [], skippedNoPartId: [], skippedDeclined: [] });
    });

    it("linked, non-declined PART → convertible", () => {
        const l = line("l1", "PART", { partId: "p1" });
        const r = filterConvertibleLines([l]);
        expect(r.convertible).toEqual([l]);
        expect(r.skippedNoPartId).toEqual([]);
        expect(r.skippedDeclined).toEqual([]);
    });

    it("PART with null partId → skippedNoPartId", () => {
        const l = line("l1", "PART", { partId: null });
        const r = filterConvertibleLines([l]);
        expect(r.skippedNoPartId).toEqual([l]);
        expect(r.convertible).toEqual([]);
    });

    it("PART with declined=true → skippedDeclined (even if partId is set)", () => {
        const l = line("l1", "PART", { partId: "p1", declined: true });
        const r = filterConvertibleLines([l]);
        expect(r.skippedDeclined).toEqual([l]);
        expect(r.convertible).toEqual([]);
    });

    it("declined takes precedence over missing partId", () => {
        // "customer said no" is more helpful than "add to inventory
        // first" — the customer's decision stands regardless of link.
        const l = line("l1", "PART", { partId: null, declined: true });
        const r = filterConvertibleLines([l]);
        expect(r.skippedDeclined).toEqual([l]);
        expect(r.skippedNoPartId).toEqual([]);
    });

    it("LABOR is ignored — not in any bucket", () => {
        const l = line("l1", "LABOR", { partId: "p1" });
        const r = filterConvertibleLines([l]);
        expect(r.convertible).toEqual([]);
        expect(r.skippedNoPartId).toEqual([]);
        expect(r.skippedDeclined).toEqual([]);
    });

    it("FEE is ignored — not in any bucket", () => {
        const l = line("l1", "FEE");
        const r = filterConvertibleLines([l]);
        expect(r.convertible).toEqual([]);
    });

    it("mixed input — buckets split correctly", () => {
        const good = line("l1", "PART", { partId: "p1" });
        const noPart = line("l2", "PART", { partId: null });
        const dec = line("l3", "PART", { partId: "p3", declined: true });
        const labor = line("l4", "LABOR", { partId: "p4" });
        const fee = line("l5", "FEE");
        const r = filterConvertibleLines([good, noPart, dec, labor, fee]);
        expect(r.convertible).toEqual([good]);
        expect(r.skippedNoPartId).toEqual([noPart]);
        expect(r.skippedDeclined).toEqual([dec]);
    });

    it("preserves ordering within each bucket", () => {
        const a = line("a", "PART", { partId: "p1" });
        const b = line("b", "PART", { partId: "p2" });
        const c = line("c", "PART", { partId: "p3" });
        const r = filterConvertibleLines([b, a, c]);
        expect(r.convertible.map((l) => l.id)).toEqual(["b", "a", "c"]);
    });
});
