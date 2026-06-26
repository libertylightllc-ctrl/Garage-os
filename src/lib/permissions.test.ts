import { describe, it, expect } from "vitest";
import { canEditEstimate, canEditInvoice, canSendEstimate } from "./permissions";

describe("estimate authority (KEY DECISION #5: advisor prices estimates, not cashier)", () => {
  it("advisor CAN edit estimates", () => {
    expect(canEditEstimate("ADVISOR")).toBe(true);
  });

  it("owner CAN edit estimates (override for single-person shops)", () => {
    expect(canEditEstimate("OWNER")).toBe(true);
  });

  it("cashier CANNOT edit estimates anymore (was the rule before; reversed 2026-06-23)", () => {
    expect(canEditEstimate("CASHIER")).toBe(false);
  });

  it("technician cannot edit estimates", () => {
    expect(canEditEstimate("TECH")).toBe(false);
  });

  it("unknown / null roles cannot edit estimates", () => {
    expect(canEditEstimate("CUSTOMER")).toBe(false);
    expect(canEditEstimate(null)).toBe(false);
    expect(canEditEstimate(undefined)).toBe(false);
  });
});

describe("invoice + payment authority (cashier owns invoicing + cash drawer)", () => {
  it("cashier CAN edit invoices + record payment", () => {
    expect(canEditInvoice("CASHIER")).toBe(true);
  });

  it("owner CAN edit invoices (override for single-person shops)", () => {
    expect(canEditInvoice("OWNER")).toBe(true);
  });

  it("advisor CANNOT generate invoices or record payment (gets estimate authority instead)", () => {
    expect(canEditInvoice("ADVISOR")).toBe(false);
  });

  it("technician cannot edit invoices", () => {
    expect(canEditInvoice("TECH")).toBe(false);
  });

  it("unknown / null roles cannot edit invoices", () => {
    expect(canEditInvoice("CUSTOMER")).toBe(false);
    expect(canEditInvoice(null)).toBe(false);
    expect(canEditInvoice(undefined)).toBe(false);
  });
});

describe("send authority (advisor + cashier both own customer comms)", () => {
  it("advisor CAN send an estimate to the customer", () => {
    expect(canSendEstimate("ADVISOR")).toBe(true);
  });

  it("cashier can also send an estimate", () => {
    expect(canSendEstimate("CASHIER")).toBe(true);
  });

  it("technician cannot send an estimate", () => {
    expect(canSendEstimate("TECH")).toBe(false);
  });
});
