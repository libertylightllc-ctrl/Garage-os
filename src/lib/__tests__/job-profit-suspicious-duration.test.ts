/**
 * computeJobProfit — suspicious-duration flag (AR 2026-08-20 Finding 2).
 *
 * Regression: INV-2026-0051 reported labour margin −122.5% (200
 * revenue / 444.91 cost). The 444.91 came from a WorkSession the
 * tech never closed — the NEXT morning's tap on another car
 * auto-closed it as SWITCHED with a ~16-hour duration, and the
 * cost snapshot was (16h × 60/hr) = ~960 → attributed to the
 * invoice as if that were real work time.
 *
 * Fix rule: any session with duration ≥ SUSPICIOUS_SESSION_MS (8h)
 * counts as UNKNOWN for profit purposes — same handling as null
 * laborCostSnapshot. The raw session data stays untouched; the
 * interpretation shifts. If any session on a job is uncovered, the
 * whole job's labour cost flips to Unknown, so INV-2026-0051's
 * card would now render "—" instead of "-122.5%".
 *
 * Pure unit test — no DB, no auth — over computeJobProfit.
 */

import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { computeJobProfit, SUSPICIOUS_SESSION_MS } from "@/lib/job-profit";

const D = (v: string | number) => new Prisma.Decimal(v);
const T0 = new Date("2026-08-19T09:00:00Z");
const durMs = (h: number) => T0.getTime() + h * 3_600_000;
const at = (h: number) => new Date(durMs(h));

const LABOR_LINE = { kind: "LABOR", qty: 1, lineTotal: "200.00", unitCost: null } as const;

describe("computeJobProfit — suspicious-duration flag", () => {
    it("under 8h — session counts (labour cost known)", () => {
        const out = computeJobProfit(
            [LABOR_LINE],
            [{ laborCostSnapshot: "60.00", startedAt: T0, endedAt: at(4) }], // 4h
        );
        expect(out.laborCost?.equals(D("60.00"))).toBe(true);
        expect(out.coverage.laborCovered).toBe(1);
    });

    it("just under 8h — still counts", () => {
        const out = computeJobProfit(
            [LABOR_LINE],
            [{
                laborCostSnapshot: "60.00",
                startedAt: T0,
                endedAt: new Date(T0.getTime() + SUSPICIOUS_SESSION_MS - 1),
            }],
        );
        expect(out.laborCost?.equals(D("60.00"))).toBe(true);
    });

    it("exactly 8h — flagged (threshold is inclusive)", () => {
        const out = computeJobProfit(
            [LABOR_LINE],
            [{
                laborCostSnapshot: "60.00",
                startedAt: T0,
                endedAt: new Date(T0.getTime() + SUSPICIOUS_SESSION_MS),
            }],
        );
        expect(out.laborCost).toBeNull();
        expect(out.coverage.laborCovered).toBe(0);
        expect(out.coverage.laborTotal).toBe(1);
    });

    it("16h SWITCHED session — the INV-2026-0051 regression case", () => {
        const out = computeJobProfit(
            [LABOR_LINE],
            [{ laborCostSnapshot: "444.91", startedAt: T0, endedAt: at(16) }],
        );
        // Snapshot value present but ignored — duration disqualifies it.
        expect(out.laborCost).toBeNull();
        expect(out.laborProfit).toBeNull();
        expect(out.laborMarginPct).toBeNull();
        expect(out.grossProfit).toBeNull();
    });

    it("mixed: one legit + one suspicious → whole job Unknown (coverage rule)", () => {
        const out = computeJobProfit(
            [LABOR_LINE],
            [
                { laborCostSnapshot: "60.00", startedAt: T0, endedAt: at(2) }, // legit
                { laborCostSnapshot: "300.00", startedAt: T0, endedAt: at(12) }, // suspicious
            ],
        );
        expect(out.laborCost).toBeNull();
        expect(out.coverage.laborCovered).toBe(1);
        expect(out.coverage.laborTotal).toBe(2);
    });

    it("startedAt / endedAt missing — check is skipped, session counts (existing tests keep working)", () => {
        const out = computeJobProfit(
            [LABOR_LINE],
            [{ laborCostSnapshot: "60.00" }],
        );
        expect(out.laborCost?.equals(D("60.00"))).toBe(true);
    });

    it("laborCostSnapshot null trumps the duration check (null-first short-circuit)", () => {
        // A session that's null-cost (auto-closed) AND >8h duration
        // still shows as unknown — same net effect either way. Just
        // asserting the null gate isn't accidentally skipped.
        const out = computeJobProfit(
            [LABOR_LINE],
            [{ laborCostSnapshot: null, startedAt: T0, endedAt: at(20) }],
        );
        expect(out.laborCost).toBeNull();
    });
});
