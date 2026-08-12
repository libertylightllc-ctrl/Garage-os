import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { computeLaborCostSnapshot } from "@/lib/worksession-cost-snapshot";

// AR 2026-08-12 profit reporting Step 4 — pins the freeze rule.
// Every assertion is a shape the real close flow can hand in.

function D(v: string | number): Prisma.Decimal {
    return new Prisma.Decimal(v);
}

function at(iso: string): Date {
    return new Date(iso);
}

describe("computeLaborCostSnapshot — happy path", () => {
    it("1 hour at 60 → 60.00", () => {
        const out = computeLaborCostSnapshot(
            at("2026-08-12T09:00:00Z"),
            at("2026-08-12T10:00:00Z"),
            "60.00",
        );
        expect(out?.equals(D("60.00"))).toBe(true);
    });

    it("30 minutes at 60 → 30.00", () => {
        const out = computeLaborCostSnapshot(
            at("2026-08-12T09:00:00Z"),
            at("2026-08-12T09:30:00Z"),
            "60.00",
        );
        expect(out?.equals(D("30.00"))).toBe(true);
    });

    it("2h 15m at 45.50 → 102.38 (102.375 rounds up)", () => {
        // 2.25 × 45.50 = 102.375 → half-up 102.38
        const out = computeLaborCostSnapshot(
            at("2026-08-12T09:00:00Z"),
            at("2026-08-12T11:15:00Z"),
            "45.50",
        );
        expect(out?.equals(D("102.38"))).toBe(true);
    });

    it("8h shift at 32.75 → 262.00", () => {
        // 8 × 32.75 = 262.00
        const out = computeLaborCostSnapshot(
            at("2026-08-12T08:00:00Z"),
            at("2026-08-12T16:00:00Z"),
            "32.75",
        );
        expect(out?.equals(D("262.00"))).toBe(true);
    });

    it("accepts number, string, and Prisma.Decimal for hourlyCost", () => {
        const args = [at("2026-08-12T09:00:00Z"), at("2026-08-12T10:00:00Z")] as const;
        expect(computeLaborCostSnapshot(...args, 50)?.equals(D("50.00"))).toBe(true);
        expect(computeLaborCostSnapshot(...args, "50")?.equals(D("50.00"))).toBe(true);
        expect(computeLaborCostSnapshot(...args, new Prisma.Decimal("50"))?.equals(D("50.00"))).toBe(true);
    });
});

describe("computeLaborCostSnapshot — unknown rate", () => {
    it("null hourlyCost → null (Unknown bucket, never zero)", () => {
        // Garage has never set a rate. Sessions closed while rate is
        // null MUST NOT record 0 (that would read as "worked for free"
        // in the profit report); they record null so the Step 5 card
        // groups them under Unknown coverage.
        const out = computeLaborCostSnapshot(
            at("2026-08-12T09:00:00Z"),
            at("2026-08-12T10:00:00Z"),
            null,
        );
        expect(out).toBeNull();
    });

    it("undefined hourlyCost → null (defensive; same reason)", () => {
        const out = computeLaborCostSnapshot(
            at("2026-08-12T09:00:00Z"),
            at("2026-08-12T10:00:00Z"),
            undefined as unknown as null,
        );
        expect(out).toBeNull();
    });
});

describe("computeLaborCostSnapshot — degenerate durations", () => {
    it("endedAt equal to startedAt → 0.00", () => {
        // Shouldn't happen in the flow (endedAt is always now() and
        // startedAt is earlier), but the helper is total.
        const out = computeLaborCostSnapshot(
            at("2026-08-12T09:00:00Z"),
            at("2026-08-12T09:00:00Z"),
            "60",
        );
        expect(out?.equals(D("0.00"))).toBe(true);
    });

    it("endedAt earlier than startedAt (clock skew) → 0.00, never negative", () => {
        // A negative cost would corrupt the ledger. Belt-and-braces.
        const out = computeLaborCostSnapshot(
            at("2026-08-12T10:00:00Z"),
            at("2026-08-12T09:00:00Z"),
            "60",
        );
        expect(out?.equals(D("0.00"))).toBe(true);
    });
});
