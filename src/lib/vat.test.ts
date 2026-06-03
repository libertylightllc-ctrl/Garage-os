import { describe, it, expect } from "vitest";
import { computeVat, UAE_VAT_RATE } from "./vat";

describe("computeVat (UAE 5%)", () => {
  it("uses a 5% default rate", () => {
    expect(UAE_VAT_RATE).toBe(0.05);
  });

  it("computes VAT and total for a round subtotal", () => {
    expect(computeVat(100)).toEqual({ subtotal: 100, vatAmount: 5, total: 105 });
  });

  it("rounds to 2 decimal places", () => {
    expect(computeVat(99.99)).toEqual({ subtotal: 99.99, vatAmount: 5, total: 104.99 });
  });

  it("handles zero", () => {
    expect(computeVat(0)).toEqual({ subtotal: 0, vatAmount: 0, total: 0 });
  });
});
