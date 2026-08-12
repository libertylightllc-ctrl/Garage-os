import { describe, it, expect } from "vitest";
import {
    pickEstimateForConversion,
    filterConvertibleLines,
    slugifyToSku,
    withCollisionSuffix,
    normalizePartName,
    findNormalizedMatch,
    type EstimateForPick,
    type EstimateLineForFilter,
} from "@/lib/estimate-to-po";

// Fixture builders — narrow, deterministic, easy to skim in a failing test.
// updatedAt defaults to a fixed date so DRAFT tie-break tests are stable
// even when the test file is edited (Prisma stamps a fresh updatedAt on
// every write, but our tests want a known ordering).
function est(
    id: string,
    status: EstimateForPick["status"],
    opts: Partial<Pick<EstimateForPick, "approvedAt" | "sentAt" | "updatedAt">> = {},
): EstimateForPick {
    return {
        id,
        status,
        approvedAt: opts.approvedAt ?? null,
        sentAt: opts.sentAt ?? null,
        updatedAt: opts.updatedAt ?? new Date("2026-01-01"),
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

    it("only a DRAFT → picked, reason=draft (DRAFT is usable now)", () => {
        const d = est("d1", "DRAFT", { updatedAt: T("2026-07-20") });
        const r = pickEstimateForConversion([d]);
        expect(r).toEqual({ kind: "picked", estimate: d, reason: "draft" });
    });

    it("only a REJECTED → all-rejected with count", () => {
        const r = pickEstimateForConversion([est("r1", "REJECTED")]);
        expect(r).toEqual({ kind: "all-rejected", totalCount: 1 });
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

    it("APPROVED + SENT → multiple (no auto-pick), sorted APPROVED first", () => {
        // The previous rule silently picked APPROVED. AR pinned this down:
        // multiple usable = surface the choice, don't decide silently. Two
        // usable estimates always mean "let the owner click one".
        const a = est("a1", "APPROVED", { approvedAt: T("2026-07-01") });
        const s = est("s1", "SENT", { sentAt: T("2026-07-15") });
        const r = pickEstimateForConversion([s, a]);
        expect(r.kind).toBe("multiple");
        if (r.kind !== "multiple") throw new Error("unreachable");
        expect(r.estimates.map((e) => e.id)).toEqual(["a1", "s1"]);
    });

    it("two APPROVED → multiple, sorted newest first (was: silent pick)", () => {
        const early = est("a-early", "APPROVED", { approvedAt: T("2026-07-01") });
        const late = est("a-late", "APPROVED", { approvedAt: T("2026-07-15") });
        const r = pickEstimateForConversion([early, late]);
        expect(r.kind).toBe("multiple");
        if (r.kind !== "multiple") throw new Error("unreachable");
        expect(r.estimates.map((e) => e.id)).toEqual(["a-late", "a-early"]);
    });

    it("APPROVED + SENT + DRAFT → multiple, sorted by rank then recency", () => {
        const a = est("a", "APPROVED", { approvedAt: T("2026-07-01") });
        const s = est("s", "SENT", { sentAt: T("2026-07-15") });
        const d = est("d", "DRAFT", { updatedAt: T("2026-07-20") });
        const r = pickEstimateForConversion([d, s, a]);
        expect(r.kind).toBe("multiple");
        if (r.kind !== "multiple") throw new Error("unreachable");
        expect(r.estimates.map((e) => e.id)).toEqual(["a", "s", "d"]);
    });

    it("two DRAFTs → multiple, sorted by updatedAt DESC", () => {
        const old = est("d-old", "DRAFT", { updatedAt: T("2026-07-01") });
        const fresh = est("d-fresh", "DRAFT", { updatedAt: T("2026-07-25") });
        const r = pickEstimateForConversion([old, fresh]);
        expect(r.kind).toBe("multiple");
        if (r.kind !== "multiple") throw new Error("unreachable");
        expect(r.estimates.map((e) => e.id)).toEqual(["d-fresh", "d-old"]);
    });

    it("REJECTED + SENT → picks SENT (single usable, REJECTED filtered)", () => {
        const s = est("s1", "SENT", { sentAt: T("2026-07-10") });
        const rej = est("r1", "REJECTED");
        const r = pickEstimateForConversion([rej, s]);
        expect(r.kind).toBe("picked");
        if (r.kind !== "picked") throw new Error("unreachable");
        expect(r.estimate.id).toBe("s1");
        expect(r.reason).toBe("sent");
    });

    it("DRAFT + REJECTED → picks DRAFT (REJECTED ignored, not 'all-rejected')", () => {
        // Previously this hit `none-usable`. Now DRAFT is usable so we
        // pick it and just skip the REJECTED.
        const d = est("d", "DRAFT", { updatedAt: T("2026-07-20") });
        const rej = est("r", "REJECTED");
        const r = pickEstimateForConversion([d, rej]);
        expect(r).toEqual({ kind: "picked", estimate: d, reason: "draft" });
    });

    it("all REJECTED (many) → all-rejected with totalCount", () => {
        const r = pickEstimateForConversion([
            est("r1", "REJECTED"),
            est("r2", "REJECTED"),
            est("r3", "REJECTED"),
        ]);
        expect(r).toEqual({ kind: "all-rejected", totalCount: 3 });
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

    it("estimateId given → picks that specific one when in usable set", () => {
        const a = est("a", "APPROVED", { approvedAt: T("2026-07-01") });
        const s = est("s", "SENT", { sentAt: T("2026-07-15") });
        const d = est("d", "DRAFT", { updatedAt: T("2026-07-20") });
        const r = pickEstimateForConversion([a, s, d], "s");
        expect(r).toEqual({ kind: "picked", estimate: s, reason: "sent" });
    });

    it("estimateId that matches a DRAFT → picks it even if APPROVED exists", () => {
        // The multi-list is where the owner sees APPROVED, SENT, DRAFT
        // and clicks one — they may deliberately pick the DRAFT.
        const a = est("a", "APPROVED", { approvedAt: T("2026-07-01") });
        const d = est("d", "DRAFT", { updatedAt: T("2026-07-20") });
        const r = pickEstimateForConversion([a, d], "d");
        expect(r).toEqual({ kind: "picked", estimate: d, reason: "draft" });
    });

    it("estimateId pointing at a REJECTED estimate → falls through to list", () => {
        // A stale link (e.g., the customer just rejected the row the
        // owner had bookmarked). Show the picker rather than silently
        // failing.
        const a = est("a", "APPROVED", { approvedAt: T("2026-07-01") });
        const rej = est("r", "REJECTED");
        const d = est("d", "DRAFT", { updatedAt: T("2026-07-20") });
        const r = pickEstimateForConversion([a, rej, d], "r");
        expect(r.kind).toBe("multiple");
        if (r.kind !== "multiple") throw new Error("unreachable");
        expect(r.estimates.map((e) => e.id)).toEqual(["a", "d"]);
    });

    it("estimateId pointing at a non-existent id → falls through to list", () => {
        const a = est("a", "APPROVED", { approvedAt: T("2026-07-01") });
        const d = est("d", "DRAFT", { updatedAt: T("2026-07-20") });
        const r = pickEstimateForConversion([a, d], "does-not-exist");
        expect(r.kind).toBe("multiple");
    });

    it("estimateId with a single usable — still returns picked (id ignored, but same result)", () => {
        const s = est("s", "SENT", { sentAt: T("2026-07-10") });
        const rej = est("r", "REJECTED");
        const r = pickEstimateForConversion([rej, s], "does-not-matter");
        expect(r).toEqual({ kind: "picked", estimate: s, reason: "sent" });
    });

    // ── Cross-scope estimateId — READ THIS BEFORE TRUSTING THE GREEN TICK
    //
    // These tests exercise the CLASSIFIER's fail-safe: "id not in
    // array → do not pick." They do NOT prove tenant isolation. The
    // real defence is the CALL SITE's Prisma query at
    // src/app/owner/purchasing/from-estimate/page.tsx: `jobCard =
    // prisma.jobCard.findFirst({ where: { garageId, number } })`
    // followed by `jobCard.estimates` — the FK scoping is what stops
    // a cross-garage / cross-job id from ever entering the array
    // this function sees.
    //
    // If a future refactor swaps that call site to something like
    // `prisma.estimate.findUnique({ where: { id: estimateId } })`,
    // or accepts an estimateId via a route param and loads by it
    // directly, these unit tests will STILL BE GREEN while the
    // tenant boundary quietly opens. The tests pin the classifier's
    // contract, not the query's. Any change to the call-site query
    // needs its own scoping test at the integration level.

    it("estimateId belongs to a DIFFERENT JOB → falls through to the picker (never renders that estimate)", () => {
        // The upstream Prisma query scopes estimates to the current
        // jobCardId; the attacker's id references an estimate on ANOTHER
        // job. From the function's POV it's just "id not in array".
        const thisJobA = est("this-job-a", "APPROVED", { approvedAt: T("2026-07-01") });
        const thisJobD = est("this-job-d", "DRAFT", { updatedAt: T("2026-07-20") });
        const otherJobId = "other-job-approved-id";
        const r = pickEstimateForConversion([thisJobA, thisJobD], otherJobId);
        expect(r.kind).toBe("multiple");
        if (r.kind !== "multiple") throw new Error("unreachable");
        // The "other job" estimate MUST NOT appear.
        expect(r.estimates.map((e) => e.id)).not.toContain(otherJobId);
        expect(r.estimates.map((e) => e.id)).toEqual(["this-job-a", "this-job-d"]);
    });

    it("estimateId belongs to a DIFFERENT GARAGE → falls through (function is a fail-safe; upstream scope is load-bearing)", () => {
        // The upstream Prisma query is scoped by garageId, so a
        // cross-garage id NEVER reaches this array. Same fall-through
        // shape as the cross-job case — this test exists to name the
        // scenario so a future reader looking for cross-tenant defence
        // sees it pinned.
        const thisGarageA = est("this-garage-a", "APPROVED", { approvedAt: T("2026-07-01") });
        const crossGarageId = "another-garages-estimate-id";
        const r = pickEstimateForConversion([thisGarageA], crossGarageId);
        // Single usable falls into `picked` (the id was ignored because
        // it wasn't found). The important assertion is that the
        // cross-garage id never becomes the picked estimate.
        expect(r).toEqual({
            kind: "picked",
            estimate: thisGarageA,
            reason: "approved",
        });
    });

    it("estimateId for a REJECTED on an all-REJECTED job → all-rejected wins (id does NOT upgrade it)", () => {
        // Every estimate on this job is REJECTED. The submitted id
        // matches one of them. The classifier must return `all-rejected`
        // — the id must NOT elevate a REJECTED row into `picked` on the
        // grounds that "well, you asked for it". Explicit test because
        // the early `usable.length === 0` return sits BEFORE the id
        // lookup; if that order ever gets swapped, we want the failure
        // to be loud here rather than in production.
        const r1 = est("r1", "REJECTED");
        const r2 = est("r2", "REJECTED");
        const r = pickEstimateForConversion([r1, r2], "r1");
        expect(r).toEqual({ kind: "all-rejected", totalCount: 2 });
    });
});

describe("filterConvertibleLines", () => {
    it("empty list → both buckets empty", () => {
        const r = filterConvertibleLines([]);
        expect(r).toEqual({ convertible: [], skippedDeclined: [] });
    });

    it("linked, non-declined PART → convertible", () => {
        const l = line("l1", "PART", { partId: "p1" });
        const r = filterConvertibleLines([l]);
        expect(r.convertible).toEqual([l]);
        expect(r.skippedDeclined).toEqual([]);
    });

    it("all-zero draft: linked PART lines with no price are STILL convertible", () => {
        // Real-world case: the shop has a draft estimate for an unpriced
        // repair (all lines unitPrice=0.00) and wants to send an RFQ to
        // the supplier. The convertibility filter must NOT gate on
        // price. `EstimateLineForFilter` deliberately doesn't carry
        // unitPrice — this test pins the behaviour a future refactor
        // might quietly break by "just adding a >0 check".
        //
        // Server-side, `parseMoney` in createPoFromEstimateAction
        // accepts non-negative (including 0) — see
        // src/app/actions/purchasing.ts — so the whole path is
        // zero-safe.
        const l1 = line("l1", "PART", { partId: "p1" });
        const l2 = line("l2", "PART", { partId: "p2" });
        const l3 = line("l3", "PART", { partId: "p3" });
        const r = filterConvertibleLines([l1, l2, l3]);
        expect(r.convertible).toEqual([l1, l2, l3]);
        expect(r.skippedDeclined).toEqual([]);
    });

    it("PART with null partId (free-text) → convertible (Layer 1, 2026-08-02)", () => {
        // Free-text lines used to be split off as `skippedNoPartId`
        // because PurchaseOrderLine.partId was NOT NULL. Layer 0 widened
        // the schema and Layer 1 rewired this filter: a description-only
        // line is a valid RFQ line and belongs on the PO. The
        // "not in your catalogue" panel on the from-estimate screen is
        // gone; there is no separate bucket for free-text.
        const l = line("l1", "PART", { partId: null });
        const r = filterConvertibleLines([l]);
        expect(r.convertible).toEqual([l]);
        expect(r.skippedDeclined).toEqual([]);
    });

    it("PART with declined=true → skippedDeclined (even if partId is set)", () => {
        const l = line("l1", "PART", { partId: "p1", declined: true });
        const r = filterConvertibleLines([l]);
        expect(r.skippedDeclined).toEqual([l]);
        expect(r.convertible).toEqual([]);
    });

    it("declined free-text line → skippedDeclined (customer said no wins over shape)", () => {
        // "customer said no" is the more helpful signal than "no catalogue
        // link" — the customer's decision stands regardless of link.
        const l = line("l1", "PART", { partId: null, declined: true });
        const r = filterConvertibleLines([l]);
        expect(r.skippedDeclined).toEqual([l]);
        expect(r.convertible).toEqual([]);
    });

    it("LABOR is ignored — not in any bucket", () => {
        const l = line("l1", "LABOR", { partId: "p1" });
        const r = filterConvertibleLines([l]);
        expect(r.convertible).toEqual([]);
        expect(r.skippedDeclined).toEqual([]);
    });

    it("FEE is ignored — not in any bucket", () => {
        const l = line("l1", "FEE");
        const r = filterConvertibleLines([l]);
        expect(r.convertible).toEqual([]);
    });

    it("mixed input — linked + free-text both convertible; declined skipped", () => {
        const linked = line("l1", "PART", { partId: "p1" });
        const freeText = line("l2", "PART", { partId: null });
        const dec = line("l3", "PART", { partId: "p3", declined: true });
        const labor = line("l4", "LABOR", { partId: "p4" });
        const fee = line("l5", "FEE");
        const r = filterConvertibleLines([linked, freeText, dec, labor, fee]);
        expect(r.convertible).toEqual([linked, freeText]);
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

describe("slugifyToSku", () => {
    it("takes the first 3 words, uppercased and hyphen-joined", () => {
        expect(slugifyToSku("Front brake pads (OEM)")).toBe("FRONT-BRAKE-PADS");
        expect(slugifyToSku("Suspension bushes set")).toBe("SUSPENSION-BUSHES-SET");
        expect(slugifyToSku("Brake sensor (fixture — no inventory link)")).toBe(
            "BRAKE-SENSOR-FIXTURE",
        );
    });
    it("passes 1- and 2-word descriptions through unchanged (uppercased)", () => {
        expect(slugifyToSku("Battery")).toBe("BATTERY");
        expect(slugifyToSku("Brake pads")).toBe("BRAKE-PADS");
    });
    it("trims leading/trailing separators without eating a real token", () => {
        expect(slugifyToSku("  brake pads  ")).toBe("BRAKE-PADS");
        expect(slugifyToSku("-brake-pads-")).toBe("BRAKE-PADS");
    });
    it("caps at 3 tokens even for long descriptions — no runaway slug", () => {
        expect(slugifyToSku("one two three four five six seven")).toBe(
            "ONE-TWO-THREE",
        );
        // Real-world example from the review UI: this used to produce
        // a 38-char slug of the whole sentence; now it stops at 3 words.
        expect(slugifyToSku("Brake sensor fixture no inventory link")).toBe(
            "BRAKE-SENSOR-FIXTURE",
        );
    });
    it("splits any non-alphanumeric run into a token boundary", () => {
        expect(slugifyToSku("AC — gas top-up")).toBe("AC-GAS-TOP");
        expect(slugifyToSku("a/b\\c d")).toBe("A-B-C");
        // Documented edge case: hyphenated part codes like 5W-30 split.
        // The shop's convention typically edits this by hand anyway.
        expect(slugifyToSku("Engine oil 5W-30")).toBe("ENGINE-OIL-5W");
    });
    it("returns empty string on unusable input — caller routes to nextAutoSku", () => {
        expect(slugifyToSku("")).toBe("");
        expect(slugifyToSku("   ")).toBe("");
        expect(slugifyToSku("...!!!")).toBe("");
    });
});

// `nextAutoSku` tests removed 2026-08-13 with the helper. See
// src/lib/estimate-to-po.ts for the deletion note.

describe("withCollisionSuffix", () => {
    it("returns the base when the SKU is free", () => {
        expect(withCollisionSuffix("BAT-70AH", new Set())).toBe("BAT-70AH");
    });
    it("appends -2 on first collision, -3 on second, etc.", () => {
        expect(withCollisionSuffix("BAT-70AH", new Set(["BAT-70AH"]))).toBe("BAT-70AH-2");
        expect(withCollisionSuffix("BAT-70AH", new Set(["BAT-70AH", "BAT-70AH-2"]))).toBe(
            "BAT-70AH-3",
        );
        expect(
            withCollisionSuffix(
                "BAT-70AH",
                new Set(["BAT-70AH", "BAT-70AH-2", "BAT-70AH-3", "BAT-70AH-4"]),
            ),
        ).toBe("BAT-70AH-5");
    });
    it("skips gaps in the sequence and takes the first free one", () => {
        // BAT-70AH taken but -2 free → gets -2, not -5.
        const taken = new Set(["BAT-70AH", "BAT-70AH-3", "BAT-70AH-4"]);
        expect(withCollisionSuffix("BAT-70AH", taken)).toBe("BAT-70AH-2");
    });
});

describe("normalizePartName", () => {
    it("lowercases + strips punctuation + collapses whitespace", () => {
        expect(normalizePartName("Engine oil 5W-30")).toBe("engine oil 5w 30");
        expect(normalizePartName("engine oil (5w30)")).toBe("engine oil 5w30");
        expect(normalizePartName("  Engine   Oil  5W30")).toBe("engine oil 5w30");
    });
    it("returns empty string for pure-punctuation input", () => {
        expect(normalizePartName("!!!")).toBe("");
        expect(normalizePartName("")).toBe("");
    });
    it("does NOT correct typos across letter substitutions (documented limit)", () => {
        // The AR case: 'break pads' typo of 'brake pads'. Different
        // normalized strings, so findNormalizedMatch will NOT fire. This
        // test pins the current behaviour so if we later swap in trigram
        // fuzzy match, we'll see this line go red and consciously accept.
        expect(normalizePartName("break pads")).not.toBe(normalizePartName("brake pads"));
    });
});

describe("findNormalizedMatch", () => {
    const parts = [
        { id: "p1", name: "Engine oil 5W-30", sku: "OIL-5W30" },
        { id: "p2", name: "Front brake pads", sku: "BRK-PAD-F" },
        { id: "p3", name: "Battery 70Ah", sku: "BAT-70AH" },
    ] as const;

    it("finds a case + punctuation-only variant", () => {
        expect(findNormalizedMatch("engine oil (5w-30)", parts)?.id).toBe("p1");
        expect(findNormalizedMatch("ENGINE OIL 5W-30", parts)?.id).toBe("p1");
    });
    it("returns null on a real semantic mismatch", () => {
        expect(findNormalizedMatch("Engine oil 10W-40", parts)).toBeNull();
        expect(findNormalizedMatch("Air filter", parts)).toBeNull();
    });
    it("returns null on a typo across letters (pinned limit — see normalizePartName test)", () => {
        // The 'break pads' vs 'brake pads' case — different normalized
        // strings, so no match. Documented limit.
        expect(findNormalizedMatch("break pads", parts)).toBeNull();
    });
});

// `computeSkuChoice` tests removed 2026-08-13 with the helper. See
// src/lib/estimate-to-po.ts for the deletion note.
