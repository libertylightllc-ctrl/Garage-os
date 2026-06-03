import { describe, it, expect } from "vitest";
import { heuristicProposal, estimateCostUsd } from "./ai";

describe("heuristicProposal (intake fallback)", () => {
  it("maps AC complaints", () => {
    const p = heuristicProposal("the ac is not cooling when it's hot");
    expect(p.likelyIssue).toMatch(/AC/i);
    expect(p.suggestedServices.length).toBeGreaterThan(0);
  });

  it("maps brake complaints as high urgency", () => {
    expect(heuristicProposal("loud grinding when I brake").urgency).toBe("HIGH");
  });

  it("falls back to general inspection for vague input", () => {
    const p = heuristicProposal("makes a weird noise sometimes");
    expect(p.likelyIssue).toMatch(/inspection/i);
  });
});

describe("estimateCostUsd", () => {
  it("is zero for the heuristic fallback", () => {
    expect(estimateCostUsd("heuristic-fallback", 1000, 1000)).toBe(0);
  });
  it("scales with tokens for a real model", () => {
    expect(estimateCostUsd("claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(1, 5);
  });
});
