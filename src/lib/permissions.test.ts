import { describe, it, expect } from "vitest";
import { canSetPrices, canSendEstimate } from "./permissions";

describe("pricing authority (KEY DECISION #5: cashier sets prices, not advisor)", () => {
  it("the advisor GENUINELY cannot set prices", () => {
    expect(canSetPrices("ADVISOR")).toBe(false);
  });

  it("the cashier CAN set prices", () => {
    expect(canSetPrices("CASHIER")).toBe(true);
  });

  it("owner can set prices (override for single-person shops)", () => {
    expect(canSetPrices("OWNER")).toBe(true);
  });

  it("technician cannot set prices", () => {
    expect(canSetPrices("TECH")).toBe(false);
  });

  it("unknown / null roles cannot set prices", () => {
    expect(canSetPrices("CUSTOMER")).toBe(false);
    expect(canSetPrices(null)).toBe(false);
    expect(canSetPrices(undefined)).toBe(false);
  });

  it("the advisor CAN still send an estimate to the customer", () => {
    expect(canSendEstimate("ADVISOR")).toBe(true);
  });

  it("the cashier can also send an estimate", () => {
    expect(canSendEstimate("CASHIER")).toBe(true);
  });

  it("the technician cannot send an estimate", () => {
    expect(canSendEstimate("TECH")).toBe(false);
  });
});
