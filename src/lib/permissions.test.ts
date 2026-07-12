import { describe, it, expect } from "vitest";
import {
  canEditEstimate,
  canEditInvoice,
  canSendEstimate,
  ESTIMATE_CREATE_ROLES,
  INVOICE_ROLES,
  SEND_ROLES,
} from "./permissions";

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

// Belt-and-braces — the helper tests above prove the FUNCTIONS read the
// constants correctly, but a regression where someone edits the constant
// arrays themselves (e.g. accidentally adding "CASHIER" back to
// ESTIMATE_CREATE_ROLES during a future refactor) would still let
// canEditEstimate("CASHIER") return true. These assertions pin the
// constants themselves, so the test fails loudly at the line that broke
// the rule, not three function-test failures deep.
describe("role-constant membership (catches direct edits to the role arrays)", () => {
  it("ESTIMATE_CREATE_ROLES contains ADVISOR + OWNER + MASTER and ONLY those", () => {
    expect(ESTIMATE_CREATE_ROLES).toEqual(
      expect.arrayContaining(["ADVISOR", "OWNER", "MASTER"]),
    );
    expect(ESTIMATE_CREATE_ROLES).not.toContain("CASHIER");
    expect(ESTIMATE_CREATE_ROLES).not.toContain("TECH");
    expect(ESTIMATE_CREATE_ROLES).toHaveLength(3);
  });

  it("INVOICE_ROLES contains CASHIER + OWNER + MASTER and ONLY those", () => {
    expect(INVOICE_ROLES).toEqual(
      expect.arrayContaining(["CASHIER", "OWNER", "MASTER"]),
    );
    expect(INVOICE_ROLES).not.toContain("ADVISOR");
    expect(INVOICE_ROLES).not.toContain("TECH");
    expect(INVOICE_ROLES).toHaveLength(3);
  });

  it("SEND_ROLES contains ADVISOR + CASHIER + OWNER + MASTER and ONLY those", () => {
    expect(SEND_ROLES).toEqual(
      expect.arrayContaining(["ADVISOR", "CASHIER", "OWNER", "MASTER"]),
    );
    expect(SEND_ROLES).not.toContain("TECH");
    expect(SEND_ROLES).toHaveLength(4);
  });

  it("estimate-create + invoice rules are disjoint except via OWNER + MASTER", () => {
    // OWNER (single-person shops) and MASTER (owner-created do-everything
    // operational login) are the only roles allowed to do BOTH sides.
    // ADVISOR or CASHIER appearing in both would contradict KEY DECISION #5.
    const overlap = ESTIMATE_CREATE_ROLES.filter((r) =>
      INVOICE_ROLES.includes(r),
    );
    expect(overlap.sort()).toEqual(["MASTER", "OWNER"]);
  });
});

// The action layer (src/app/actions/billing.ts) calls requireAnyRole()
// with one of these three role arrays. Asserting these consistency
// invariants here means a constant + helper drift can't sneak through —
// every helper agrees with its array. (This is the "the array IS the
// source of truth, prove the helper reads it" cross-check.)
describe("helper ↔ array consistency", () => {
  it("canEditEstimate is true iff role is in ESTIMATE_CREATE_ROLES", () => {
    for (const r of ["OWNER", "ADVISOR", "CASHIER", "TECH", "MASTER", "CUSTOMER"]) {
      expect(canEditEstimate(r)).toBe(ESTIMATE_CREATE_ROLES.includes(r));
    }
  });

  it("canEditInvoice is true iff role is in INVOICE_ROLES", () => {
    for (const r of ["OWNER", "ADVISOR", "CASHIER", "TECH", "MASTER", "CUSTOMER"]) {
      expect(canEditInvoice(r)).toBe(INVOICE_ROLES.includes(r));
    }
  });

  it("canSendEstimate is true iff role is in SEND_ROLES", () => {
    for (const r of ["OWNER", "ADVISOR", "CASHIER", "TECH", "MASTER", "CUSTOMER"]) {
      expect(canSendEstimate(r)).toBe(SEND_ROLES.includes(r));
    }
  });
});
