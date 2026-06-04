import { describe, it, expect } from "vitest";
import { scopeWhere, companyRootId } from "./branches";

describe("branch scoping", () => {
  it("scopeWhere passes a single id through unchanged", () => {
    expect(scopeWhere("g1")).toBe("g1");
  });

  it("scopeWhere wraps multiple ids in an `in` filter", () => {
    expect(scopeWhere(["g1", "g2", "g3"])).toEqual({ in: ["g1", "g2", "g3"] });
  });

  it("companyRootId returns the parent for a branch", () => {
    expect(companyRootId({ id: "branch1", branchOfId: "company" })).toBe("company");
  });

  it("companyRootId returns itself for the company root", () => {
    expect(companyRootId({ id: "company", branchOfId: null })).toBe("company");
  });
});
