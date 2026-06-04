import { describe, it, expect } from "vitest";
import { canClaim, isClaimedBy, canLogWork, canJoinAsHelper, type ClaimableJob } from "./claim";

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

describe("canLogWork (primary + helpers, Tier 2 #4)", () => {
  it("anyone can act on an unclaimed job (auto-claim)", () => {
    expect(canLogWork({ claimedById: null }, "tech-1")).toBe(true);
  });
  it("the primary claimer can log work", () => {
    expect(canLogWork({ claimedById: "tech-1" }, "tech-1")).toBe(true);
  });
  it("a helper can log work; an unrelated tech cannot", () => {
    expect(canLogWork({ claimedById: "tech-1" }, "tech-2", ["tech-2"])).toBe(true);
    expect(canLogWork({ claimedById: "tech-1" }, "tech-3", ["tech-2"])).toBe(false);
  });
});

describe("canJoinAsHelper", () => {
  it("can join a job claimed by someone else", () => {
    expect(canJoinAsHelper({ status: "REPAIR", claimedById: "tech-1" }, "tech-2")).toBe(true);
  });
  it("cannot join your own job, an unclaimed one, or as a duplicate helper", () => {
    expect(canJoinAsHelper({ status: "REPAIR", claimedById: "tech-1" }, "tech-1")).toBe(false);
    expect(canJoinAsHelper({ status: "REPAIR", claimedById: null }, "tech-2")).toBe(false);
    expect(canJoinAsHelper({ status: "REPAIR", claimedById: "tech-1" }, "tech-2", ["tech-2"])).toBe(false);
  });
  it("cannot join a terminal job", () => {
    expect(canJoinAsHelper({ status: "DELIVERED", claimedById: "tech-1" }, "tech-2")).toBe(false);
  });
});
