import { describe, it, expect } from "vitest";
import {
    pickEstimateForConversion,
    filterConvertibleLines,
    slugifyToSku,
    nextAutoSku,
    withCollisionSuffix,
    normalizePartName,
    findNormalizedMatch,
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

describe("nextAutoSku", () => {
    it("returns AUTO-1 when nothing is taken", () => {
        expect(nextAutoSku(new Set())).toBe("AUTO-1");
    });
    it("returns AUTO-2 when AUTO-1 is taken", () => {
        expect(nextAutoSku(new Set(["AUTO-1"]))).toBe("AUTO-2");
    });
    it("skips gaps and takes the first free slot", () => {
        expect(nextAutoSku(new Set(["AUTO-1", "AUTO-3"]))).toBe("AUTO-2");
        expect(nextAutoSku(new Set(["AUTO-1", "AUTO-2", "AUTO-4"]))).toBe("AUTO-3");
    });
    it("ignores real-shop SKUs — only counts the AUTO- prefix", () => {
        const taken = new Set(["BAT-70AH", "OIL-5W30", "BRK-PAD-F"]);
        expect(nextAutoSku(taken)).toBe("AUTO-1");
    });
    it("keeps walking past dense AUTO ranges", () => {
        const dense = new Set(
            Array.from({ length: 20 }, (_, i) => `AUTO-${i + 1}`),
        );
        expect(nextAutoSku(dense)).toBe("AUTO-21");
    });
});

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
