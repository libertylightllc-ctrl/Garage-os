import { describe, it, expect } from "vitest";
import { canSubmitFindings, nextStatusAfterFindings, cleanQty } from "./jobfindings";

describe("technician findings", () => {
  it("can submit only when findings text is present", () => {
    expect(canSubmitFindings({ findings: "Worn pads" })).toBe(true);
    expect(canSubmitFindings({ findings: "   " })).toBe(false);
    expect(canSubmitFindings({ findings: "" })).toBe(false);
    expect(canSubmitFindings({ findings: null })).toBe(false);
    expect(canSubmitFindings(null)).toBe(false);
    expect(canSubmitFindings(undefined)).toBe(false);
  });

  it("advances early stages to ESTIMATE, leaves others unchanged", () => {
    expect(nextStatusAfterFindings("ARRIVED")).toBe("ESTIMATE");
    expect(nextStatusAfterFindings("INSPECTION")).toBe("ESTIMATE");
    expect(nextStatusAfterFindings("ESTIMATE")).toBe("ESTIMATE");
    expect(nextStatusAfterFindings("REPAIR")).toBe("REPAIR");
    expect(nextStatusAfterFindings("ON_HOLD")).toBe("ON_HOLD");
    expect(nextStatusAfterFindings("DELIVERED")).toBe("DELIVERED");
  });

  it("clamps quantity to a positive integer", () => {
    expect(cleanQty(3)).toBe(3);
    expect(cleanQty(0)).toBe(1);
    expect(cleanQty(-5)).toBe(1);
    expect(cleanQty(2.9)).toBe(2);
    expect(cleanQty(NaN)).toBe(1);
  });
});
