import { describe, it, expect } from "vitest";
import { formatDuration, durationBetween, elapsedSince } from "./duration";

const SEC = 1000;
const MIN = 60 * SEC;
const HR = 60 * MIN;
const DAY = 24 * HR;

describe("formatDuration", () => {
  it("under a minute → 'just now'", () => {
    expect(formatDuration(0)).toBe("just now");
    expect(formatDuration(45 * SEC)).toBe("just now");
    expect(formatDuration(59 * SEC + 999)).toBe("just now");
  });

  it("minute boundary → 'Xm'", () => {
    expect(formatDuration(60 * SEC)).toBe("1m");
    expect(formatDuration(12 * MIN)).toBe("12m");
    expect(formatDuration(59 * MIN)).toBe("59m");
  });

  it("hour-with-minutes → 'Xh Ym'", () => {
    expect(formatDuration(HR)).toBe("1h"); // exactly on the hour, no 'Ym'
    expect(formatDuration(HR + 23 * MIN)).toBe("1h 23m");
    expect(formatDuration(2 * HR + 5 * MIN)).toBe("2h 5m");
    expect(formatDuration(23 * HR + 59 * MIN)).toBe("23h 59m");
  });

  it("day-with-hours → 'Xd Yh'", () => {
    expect(formatDuration(DAY)).toBe("1d");
    expect(formatDuration(DAY + 5 * HR)).toBe("1d 5h");
    expect(formatDuration(3 * DAY + 12 * HR)).toBe("3d 12h");
  });

  it("clamps negatives to 0 ('just now') instead of going backwards", () => {
    expect(formatDuration(-1)).toBe("just now");
    expect(formatDuration(-1_000_000)).toBe("just now");
  });

  it("returns '' for NaN / Infinity (caller can hide gracefully)", () => {
    expect(formatDuration(NaN)).toBe("");
    expect(formatDuration(Infinity)).toBe("");
    expect(formatDuration(-Infinity)).toBe("");
  });
});

describe("durationBetween", () => {
  it("normal pair → format the diff", () => {
    const a = new Date("2026-06-08T10:00:00Z");
    const b = new Date("2026-06-08T10:23:00Z");
    expect(durationBetween(a, b)).toBe("23m");
  });

  it("end before start → 'just now' (clamped, never negative)", () => {
    const a = new Date("2026-06-08T10:23:00Z");
    const b = new Date("2026-06-08T10:00:00Z");
    expect(durationBetween(a, b)).toBe("just now");
  });

  it("either side null → '' (caller decides what to render)", () => {
    expect(durationBetween(null, new Date())).toBe("");
    expect(durationBetween(new Date(), null)).toBe("");
    expect(durationBetween(undefined, undefined)).toBe("");
  });
});

describe("elapsedSince", () => {
  it("returns the live-elapsed time relative to a passed-in now", () => {
    const start = new Date("2026-06-08T09:00:00Z");
    const now = new Date("2026-06-08T11:30:00Z");
    expect(elapsedSince(start, now)).toBe("2h 30m");
  });
  it("null start → ''", () => {
    expect(elapsedSince(null, new Date())).toBe("");
  });
});
