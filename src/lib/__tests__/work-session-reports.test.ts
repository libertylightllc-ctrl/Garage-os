import { describe, expect, it } from "vitest";
import {
  computeJobTimeSummary,
  computeTechWrenchTime,
  computeTechDailyHistory,
  STALE_SESSION_MIN,
} from "@/lib/work-session-reports";

const now = new Date("2026-07-13T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe("computeJobTimeSummary", () => {
  it("switch-return: A worked 40m, switched, came back 20m = 60m across 2 sessions", () => {
    const sessions = [
      { id: "s1", techId: "t1", techName: "Tariq", startedAt: ago(120), endedAt: ago(80), endReason: "SWITCHED" },
      { id: "s2", techId: "t1", techName: "Tariq", startedAt: ago(30), endedAt: ago(10), endReason: "COMPLETED" },
    ];
    const result = computeJobTimeSummary(sessions, now);
    expect(result.totalMin).toBe(60);
    expect(result.sessionCount).toBe(2);
    expect(result.byTech).toHaveLength(1);
    expect(result.byTech[0].techId).toBe("t1");
    expect(result.byTech[0].totalMin).toBe(60);
    expect(result.byTech[0].sessions).toBe(2);
  });

  it("multi-tech: Tariq 45m + Ahmed 15m = 60m total, per-tech breakdown correct", () => {
    const sessions = [
      { id: "s1", techId: "t1", techName: "Tariq", startedAt: ago(60), endedAt: ago(15), endReason: "SWITCHED" },
      { id: "s2", techId: "t2", techName: "Ahmed", startedAt: ago(15), endedAt: ago(0), endReason: "COMPLETED" },
    ];
    const result = computeJobTimeSummary(sessions, now);
    expect(result.totalMin).toBe(60);
    expect(result.sessionCount).toBe(2);
    expect(result.byTech).toHaveLength(2);
    const tariq = result.byTech.find((t) => t.techId === "t1")!;
    const ahmed = result.byTech.find((t) => t.techId === "t2")!;
    expect(tariq.totalMin).toBe(45);
    expect(ahmed.totalMin).toBe(15);
  });

  it("open session counts up to now", () => {
    const sessions = [
      { id: "s1", techId: "t1", techName: "Tariq", startedAt: ago(30), endedAt: null, endReason: null },
    ];
    const result = computeJobTimeSummary(sessions, now);
    expect(result.totalMin).toBe(30);
    expect(result.sessionCount).toBe(1);
    expect(result.byTech[0].totalMin).toBe(30);
  });

  it("empty job = 0 time, 0 sessions", () => {
    const result = computeJobTimeSummary([], now);
    expect(result.totalMin).toBe(0);
    expect(result.sessionCount).toBe(0);
    expect(result.byTech).toHaveLength(0);
    expect(result.stale).toBe(false);
  });

  it("stale flag fires at threshold, not below", () => {
    const belowThreshold = [
      { id: "s1", techId: "t1", techName: "Tariq", startedAt: ago(STALE_SESSION_MIN - 1), endedAt: ago(0), endReason: "COMPLETED" },
    ];
    expect(computeJobTimeSummary(belowThreshold, now).stale).toBe(false);

    const atThreshold = [
      { id: "s2", techId: "t1", techName: "Tariq", startedAt: ago(STALE_SESSION_MIN), endedAt: ago(0), endReason: "COMPLETED" },
    ];
    expect(computeJobTimeSummary(atThreshold, now).stale).toBe(true);
  });

  it("stale flag fires on open session exceeding threshold", () => {
    const sessions = [
      { id: "s1", techId: "t1", techName: "Tariq", startedAt: ago(200), endedAt: null, endReason: null },
    ];
    const result = computeJobTimeSummary(sessions, now);
    expect(result.stale).toBe(true);
    expect(result.totalMin).toBe(200);
  });
});

describe("computeTechWrenchTime", () => {
  it("aggregates per tech across multiple cars", () => {
    const sessions = [
      { techId: "t1", techName: "Tariq", jobCardId: "j1", startedAt: ago(90), endedAt: ago(60) },
      { techId: "t1", techName: "Tariq", jobCardId: "j2", startedAt: ago(50), endedAt: ago(20) },
      { techId: "t2", techName: "Ahmed", jobCardId: "j1", startedAt: ago(60), endedAt: ago(50) },
    ];
    const result = computeTechWrenchTime(sessions, now);
    expect(result).toHaveLength(2);

    const tariq = result.find((r) => r.techId === "t1")!;
    expect(tariq.totalMin).toBe(60);
    expect(tariq.carsTouched).toBe(2);
    expect(tariq.avgPerCarMin).toBe(30);

    const ahmed = result.find((r) => r.techId === "t2")!;
    expect(ahmed.totalMin).toBe(10);
    expect(ahmed.carsTouched).toBe(1);
    expect(ahmed.avgPerCarMin).toBe(10);
  });

  it("sorted by total time descending", () => {
    const sessions = [
      { techId: "t2", techName: "Ahmed", jobCardId: "j1", startedAt: ago(100), endedAt: ago(10) },
      { techId: "t1", techName: "Tariq", jobCardId: "j1", startedAt: ago(20), endedAt: ago(10) },
    ];
    const result = computeTechWrenchTime(sessions, now);
    expect(result[0].techId).toBe("t2");
    expect(result[1].techId).toBe("t1");
  });

  it("counts stale sessions per tech", () => {
    const sessions = [
      { techId: "t1", techName: "Tariq", jobCardId: "j1", startedAt: ago(200), endedAt: ago(0) },
      { techId: "t1", techName: "Tariq", jobCardId: "j2", startedAt: ago(30), endedAt: ago(20) },
    ];
    const result = computeTechWrenchTime(sessions, now);
    expect(result[0].staleSessions).toBe(1);
  });

  it("same car revisited counts as 1 car touched", () => {
    const sessions = [
      { techId: "t1", techName: "Tariq", jobCardId: "j1", startedAt: ago(60), endedAt: ago(40) },
      { techId: "t1", techName: "Tariq", jobCardId: "j1", startedAt: ago(30), endedAt: ago(10) },
    ];
    const result = computeTechWrenchTime(sessions, now);
    expect(result[0].carsTouched).toBe(1);
    expect(result[0].totalMin).toBe(40);
  });

  it("empty sessions = empty result", () => {
    expect(computeTechWrenchTime([], now)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Slice 3 — computeTechDailyHistory
// ---------------------------------------------------------------------------

describe("computeTechDailyHistory", () => {
  // UAE +4h offset = 240 minutes
  const TZ = 240;
  // "now" is 2026-07-13 12:00 UTC = 2026-07-13 16:00 UAE
  const hSession = (
    jobCardId: string, jobNumber: number, make: string, plate: string,
    startMinAgo: number, endMinAgo: number | null,
  ) => ({
    jobCardId, jobNumber, vehicleMake: make, vehiclePlate: plate,
    startedAt: ago(startMinAgo),
    endedAt: endMinAgo === null ? null : ago(endMinAgo),
  });

  it("same car on 2 different days: shows under both, correct per-day time", () => {
    // Day 1 (yesterday UAE): session 1440m ago → 1400m ago = 40m
    // Day 2 (today UAE):     session 60m ago → 20m ago = 40m
    const sessions = [
      hSession("j1", 1, "Toyota", "A 123", 1440, 1400),
      hSession("j1", 1, "Toyota", "A 123", 60, 20),
    ];
    const result = computeTechDailyHistory(sessions, now, TZ);

    expect(result.days).toHaveLength(2);
    expect(result.totalMin).toBe(80);
    expect(result.totalCars).toBe(1); // same car, 1 distinct
    expect(result.totalDays).toBe(2);
    expect(result.avgPerDayMin).toBe(40);

    // Each day has the car with 40m
    for (const day of result.days) {
      expect(day.carsTouched).toBe(1);
      expect(day.cars[0].jobCardId).toBe("j1");
      expect(day.cars[0].totalMin).toBe(40);
    }
  });

  it("multi-day range totals: 3 days, 2 cars", () => {
    const sessions = [
      hSession("j1", 1, "Toyota", "A 123", 2 * 1440, 2 * 1440 - 60),     // 2 days ago, 60m
      hSession("j2", 2, "Nissan", "B 456", 1440, 1440 - 30),              // 1 day ago, 30m
      hSession("j1", 1, "Toyota", "A 123", 1440 - 30, 1440 - 60),         // 1 day ago, 30m (same day as j2)
      hSession("j2", 2, "Nissan", "B 456", 120, 60),                       // today, 60m
    ];
    const result = computeTechDailyHistory(sessions, now, TZ);

    expect(result.totalDays).toBe(3);
    expect(result.totalMin).toBe(180);
    expect(result.totalCars).toBe(2);
    expect(result.avgPerDayMin).toBe(60);
  });

  it("stale session flagged per-day and in totals", () => {
    const sessions = [
      hSession("j1", 1, "Toyota", "A 123", STALE_SESSION_MIN + 10, 0), // stale: 190m
      hSession("j2", 2, "Nissan", "B 456", 30, 10),                      // normal: 20m
    ];
    const result = computeTechDailyHistory(sessions, now, TZ);

    expect(result.staleSessions).toBe(1);
    const dayWithStale = result.days.find((d) => d.staleSessions > 0)!;
    expect(dayWithStale).toBeDefined();
    expect(dayWithStale.staleSessions).toBe(1);
    const staleCar = dayWithStale.cars.find((c) => c.jobCardId === "j1")!;
    expect(staleCar.stale).toBe(true);
  });

  it("empty range = zero everything", () => {
    const result = computeTechDailyHistory([], now, TZ);
    expect(result.days).toHaveLength(0);
    expect(result.totalMin).toBe(0);
    expect(result.totalCars).toBe(0);
    expect(result.totalDays).toBe(0);
    expect(result.avgPerDayMin).toBe(0);
    expect(result.staleSessions).toBe(0);
  });

  it("open session counts up to now", () => {
    const sessions = [
      hSession("j1", 1, "Toyota", "A 123", 45, null), // 45m open
    ];
    const result = computeTechDailyHistory(sessions, now, TZ);
    expect(result.totalMin).toBe(45);
    expect(result.days).toHaveLength(1);
    expect(result.days[0].cars[0].totalMin).toBe(45);
  });

  it("day grouping uses tz offset: session at 23:00 UTC = next day in +4", () => {
    // 23:00 UTC on Jul 12 = 03:00 Jul 13 in UAE (+4)
    // So this should land on Jul 13 in UAE timezone
    const s = {
      jobCardId: "j1", jobNumber: 1, vehicleMake: "Toyota", vehiclePlate: "A 123",
      startedAt: new Date("2026-07-12T23:00:00Z"),
      endedAt: new Date("2026-07-12T23:30:00Z"),
    };
    const result = computeTechDailyHistory([s], now, TZ);
    expect(result.days).toHaveLength(1);
    expect(result.days[0].date).toBe("2026-07-13");
  });

  it("cars sorted by time descending within each day", () => {
    const sessions = [
      hSession("j1", 1, "Toyota", "A 123", 120, 100),  // 20m
      hSession("j2", 2, "Nissan", "B 456", 100, 40),   // 60m
    ];
    const result = computeTechDailyHistory(sessions, now, TZ);
    expect(result.days[0].cars[0].jobCardId).toBe("j2"); // 60m first
    expect(result.days[0].cars[1].jobCardId).toBe("j1"); // 20m second
  });

  it("days sorted newest first", () => {
    const sessions = [
      hSession("j1", 1, "Toyota", "A 123", 1440 + 60, 1440),  // yesterday
      hSession("j2", 2, "Nissan", "B 456", 60, 30),             // today
    ];
    const result = computeTechDailyHistory(sessions, now, TZ);
    expect(result.days[0].date > result.days[1].date).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Suspicious-session exclusion — AR 2026-08-20. The AA0076 33h
// session was silently double-counting into Hours totals (34h total,
// 17h/day avg). Rule from the profit-card work: sessions ≥8h are
// EXCLUDED from totals and reported on a coverage line, matching
// job-profit.ts SUSPICIOUS_SESSION_MS.
// ────────────────────────────────────────────────────────────────

const EIGHT_H = 8 * 60;
const NINE_H = 9 * 60;

describe("computeJobTimeSummary — suspicious-session exclusion", () => {
  it("session under 8h counts normally", () => {
    const sessions = [
      { id: "s1", techId: "t1", techName: "Tariq", startedAt: ago(EIGHT_H - 1), endedAt: ago(0), endReason: "SWITCHED" },
    ];
    const r = computeJobTimeSummary(sessions, now);
    expect(r.totalMin).toBe(EIGHT_H - 1);
    expect(r.excludedSessions).toBe(0);
    expect(r.excludedMin).toBe(0);
  });

  it("exactly 8h — flagged (threshold inclusive)", () => {
    const sessions = [
      { id: "s1", techId: "t1", techName: "Tariq", startedAt: ago(EIGHT_H), endedAt: ago(0), endReason: "SWITCHED" },
    ];
    const r = computeJobTimeSummary(sessions, now);
    expect(r.totalMin).toBe(0);
    expect(r.excludedSessions).toBe(1);
    expect(r.excludedMin).toBe(EIGHT_H);
    expect(r.byTech).toHaveLength(0);
  });

  it("33h AA0076-shaped session — excluded, matches the regression case", () => {
    const sessions = [
      { id: "s1", techId: "t1", techName: "Master", startedAt: ago(33 * 60), endedAt: ago(0), endReason: null },
    ];
    const r = computeJobTimeSummary(sessions, now);
    expect(r.totalMin).toBe(0);
    expect(r.sessionCount).toBe(1);
    expect(r.excludedSessions).toBe(1);
    expect(r.excludedMin).toBe(33 * 60);
  });

  it("mixed: 45m + 12h — the 45m counts, the 12h excluded", () => {
    const sessions = [
      { id: "s1", techId: "t1", techName: "Tariq", startedAt: ago(45), endedAt: ago(0), endReason: "SWITCHED" },
      { id: "s2", techId: "t1", techName: "Tariq", startedAt: ago(12 * 60), endedAt: ago(0), endReason: null },
    ];
    const r = computeJobTimeSummary(sessions, now);
    expect(r.totalMin).toBe(45);
    expect(r.excludedSessions).toBe(1);
    expect(r.excludedMin).toBe(12 * 60);
    // Tariq's per-tech total ONLY includes the 45m — the linchpin
    // for payroll not being inflated by the excluded row.
    expect(r.byTech[0].totalMin).toBe(45);
    expect(r.byTech[0].sessions).toBe(1);
  });
});

describe("computeTechWrenchTime — suspicious-session exclusion", () => {
  it("excluded session does NOT count into totalMin OR carsTouched", () => {
    const sessions = [
      { techId: "t1", techName: "Tariq", jobCardId: "j1", startedAt: ago(30), endedAt: ago(0) },
      { techId: "t1", techName: "Tariq", jobCardId: "j2", startedAt: ago(NINE_H), endedAt: ago(0) },
    ];
    const r = computeTechWrenchTime(sessions, now);
    expect(r).toHaveLength(1);
    // Only j1's 30m counts.
    expect(r[0].totalMin).toBe(30);
    expect(r[0].carsTouched).toBe(1);
    expect(r[0].avgPerCarMin).toBe(30);
    expect(r[0].excludedSessions).toBe(1);
  });
});

describe("computeTechDailyHistory — suspicious-session exclusion", () => {
  const TZ = 240; // UAE +4
  const hSession = (
    jobCardId: string, jobNumber: number, make: string, plate: string,
    startAgoMin: number, endAgoMin: number | null,
  ) => ({
    jobCardId, jobNumber, vehicleMake: make, vehiclePlate: plate,
    startedAt: ago(startAgoMin),
    endedAt: endAgoMin === null ? null : ago(endAgoMin),
  });

  it("day totals + avgPerDayMin exclude ≥8h; coverage line surfaces the count", () => {
    const sessions = [
      hSession("j1", 1, "Toyota", "A 123", 60, 30),   // 30m — counts
      hSession("j1", 1, "Toyota", "A 123", 33 * 60, 0), // 33h — excluded (AA0076-shaped)
    ];
    const r = computeTechDailyHistory(sessions, now, TZ);
    expect(r.excludedSessions).toBe(1);
    expect(r.excludedMin).toBe(33 * 60);
    // The excluded session doesn't even create a day row on its own —
    // only the 30m session groups. So totalDays=1 and totalMin=30.
    expect(r.totalMin).toBe(30);
    expect(r.totalDays).toBe(1);
    expect(r.avgPerDayMin).toBe(30);
    expect(r.totalCars).toBe(1);
  });
});
