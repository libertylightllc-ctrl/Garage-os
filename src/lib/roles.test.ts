import { describe, it, expect } from "vitest";
import { roleHome, STAFF_ROLES, ROLE_HOME } from "./roles";

describe("roleHome", () => {
  it("routes each staff role to its own home", () => {
    expect(roleHome("OWNER")).toBe("/owner");
    expect(roleHome("ADVISOR")).toBe("/advisor");
    expect(roleHome("TECH")).toBe("/technician");
    expect(roleHome("CASHIER")).toBe("/cashier");
  });

  it("maps every known staff role to a distinct route", () => {
    const homes = STAFF_ROLES.map(roleHome);
    expect(new Set(homes).size).toBe(STAFF_ROLES.length);
  });

  it("falls back to /login for unknown, null, or customer-ish roles", () => {
    expect(roleHome("CUSTOMER")).toBe("/login");
    expect(roleHome("")).toBe("/login");
    expect(roleHome(null)).toBe("/login");
    expect(roleHome(undefined)).toBe("/login");
  });

  it("has exactly the 4 staff roles", () => {
    expect(Object.keys(ROLE_HOME).sort()).toEqual(
      ["ADVISOR", "CASHIER", "OWNER", "TECH"],
    );
  });
});
