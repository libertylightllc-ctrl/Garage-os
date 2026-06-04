import { describe, it, expect } from "vitest";
import { canClaim, isClaimedBy, type ClaimableJob } from "./claim";

const job = (over: Partial<ClaimableJob>): ClaimableJob => ({
  status: "ARRIVED",
  claimedById: null,
  assignedToId: null,
  ...over,
});

describe("canClaim (waiting-pool eligibility)", () => {
  it("unclaimed + unassigned + active is claimable by anyone", () => {
    expect(canClaim(job({}), "tech-1")).toBe(true);
  });
  it("a car already claimed is NOT claimable by another tech", () => {
    expect(canClaim(job({ claimedById: "tech-2" }), "tech-1")).toBe(false);
  });
  it("a car assigned to another tech is not in my pool", () => {
    expect(canClaim(job({ assignedToId: "tech-2" }), "tech-1")).toBe(false);
  });
  it("a car assigned to me IS in my pool", () => {
    expect(canClaim(job({ assignedToId: "tech-1" }), "tech-1")).toBe(true);
  });
  it("terminal jobs are never claimable", () => {
    expect(canClaim(job({ status: "DELIVERED" }), "tech-1")).toBe(false);
    expect(canClaim(job({ status: "CANCELLED" }), "tech-1")).toBe(false);
  });
});

describe("isClaimedBy", () => {
  it("true only for the claimer", () => {
    expect(isClaimedBy(job({ claimedById: "tech-1" }), "tech-1")).toBe(true);
    expect(isClaimedBy(job({ claimedById: "tech-2" }), "tech-1")).toBe(false);
  });
});
