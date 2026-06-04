import { describe, it, expect } from "vitest";
import { priorityMeta, clampPriority } from "./priority";

describe("queue priority", () => {
  it("maps levels to labels + badges", () => {
    expect(priorityMeta(0)).toEqual({ key: "prNormal", badge: "" });
    expect(priorityMeta(1)).toEqual({ key: "prUrgent", badge: "⭐" });
    expect(priorityMeta(2)).toEqual({ key: "prEmergency", badge: "🔴" });
  });

  it("treats anything >= 2 as emergency and null as normal", () => {
    expect(priorityMeta(5).key).toBe("prEmergency");
    expect(priorityMeta(null).key).toBe("prNormal");
    expect(priorityMeta(undefined).key).toBe("prNormal");
  });

  it("clamps input to 0..2", () => {
    expect(clampPriority(-3)).toBe(0);
    expect(clampPriority(1)).toBe(1);
    expect(clampPriority(9)).toBe(2);
    expect(clampPriority(1.9)).toBe(1);
    expect(clampPriority(NaN)).toBe(0);
  });
});
