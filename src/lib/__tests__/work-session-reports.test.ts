import { describe, expect, it } from "vitest";
import {
  computeJobTimeSummary,
  computeTechWrenchTime,
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
