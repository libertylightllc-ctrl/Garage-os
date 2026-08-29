// Pin the month-boundary + trend math on the owner dashboard.
// Pure unit tests — the SQL layer is exercised on CI's real
// Postgres via the wider vitest run; here we just prove the
// TZ + window math doesn't drift.

import { describe, it, expect } from "vitest";
import { _testonly } from "@/lib/owner-dashboard";

const { startOfMonthInTz, startOfPrevMonthInTz, sameWindowEndLastMonth } = _testonly;

describe("startOfMonthInTz (Asia/Dubai)", () => {
    it("returns Dubai-midnight-of-the-1st as a UTC instant", () => {
        // Sept 15 2026 10:30 Dubai = Sept 15 2026 06:30 UTC.
        // Month start should be Sept 1 2026 00:00 Dubai
        //                      = Aug 31 2026 20:00 UTC.
        const now = new Date("2026-09-15T06:30:00Z");
        const start = startOfMonthInTz(now, "Asia/Dubai");
        expect(start.toISOString()).toBe("2026-08-31T20:00:00.000Z");
    });

    it("mid-month sanity: still returns the 1st of that month, not the 1st of next", () => {
        const now = new Date("2026-11-20T09:00:00Z");
        const start = startOfMonthInTz(now, "Asia/Dubai");
        // Nov 1 2026 00:00 Dubai = Oct 31 2026 20:00 UTC.
        expect(start.toISOString()).toBe("2026-10-31T20:00:00.000Z");
    });

    it("first-of-month at Dubai-midnight edge case is inclusive of the new month", () => {
        // Oct 1 2026 00:00:01 Dubai = Sept 30 2026 20:00:01 UTC.
        // Month start should be Oct 1, not Sept 1.
        const now = new Date("2026-09-30T20:00:01Z");
        const start = startOfMonthInTz(now, "Asia/Dubai");
        expect(start.toISOString()).toBe("2026-09-30T20:00:00.000Z");
    });
});

describe("startOfPrevMonthInTz (Asia/Dubai)", () => {
    it("Sept → Aug", () => {
        const now = new Date("2026-09-15T06:30:00Z");
        const prev = startOfPrevMonthInTz(now, "Asia/Dubai");
        expect(prev.toISOString()).toBe("2026-07-31T20:00:00.000Z");
    });

    it("handles year rollover: Jan → Dec of previous year", () => {
        const now = new Date("2027-01-10T09:00:00Z");
        const prev = startOfPrevMonthInTz(now, "Asia/Dubai");
        expect(prev.toISOString()).toBe("2026-11-30T20:00:00.000Z");
    });
});

describe("sameWindowEndLastMonth — accountant's fair comparison", () => {
    it("Sept 15 mid-day → last-month window ends at Aug 15 mid-day (same elapsed)", () => {
        const now = new Date("2026-09-15T09:00:00Z");
        // Sept 1 Dubai = Aug 31 20:00 UTC. Elapsed from Sept 1 to
        // now = (Sept 15 09:00 UTC - Aug 31 20:00 UTC).
        const end = sameWindowEndLastMonth(now, "Asia/Dubai");
        // Last month same window: prev start (Jul 31 20:00 UTC) +
        // that elapsed span.
        const thisStart = new Date("2026-08-31T20:00:00Z");
        const elapsed = now.getTime() - thisStart.getTime();
        const prevStart = new Date("2026-07-31T20:00:00Z");
        expect(end.toISOString()).toBe(
            new Date(prevStart.getTime() + elapsed).toISOString(),
        );
    });

    it("On the 3rd of the month, last-month window is 3 days, not the full previous month", () => {
        // Sept 3 2026 09:00 UTC (= Sept 3 13:00 Dubai).
        const now = new Date("2026-09-03T09:00:00Z");
        const end = sameWindowEndLastMonth(now, "Asia/Dubai");
        // Last-month window should end ~3 days into August, NOT
        // at Sept 1. If it ended at Sept 1, the "vs last month"
        // comparison would show partial-Sept against full-Aug and
        // read as "we're worse!" on the 3rd of the month.
        const augStart = new Date("2026-07-31T20:00:00Z");
        expect(end.getTime()).toBeLessThan(new Date("2026-09-01T00:00:00Z").getTime());
        expect(end.getTime()).toBeGreaterThan(augStart.getTime());
        // Elapsed since Sept 1 Dubai = elapsed since Aug 1 Dubai.
        const elapsed = now.getTime() - new Date("2026-08-31T20:00:00Z").getTime();
        expect(end.getTime()).toBe(augStart.getTime() + elapsed);
    });
});
