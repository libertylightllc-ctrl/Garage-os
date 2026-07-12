import { describe, it, expect } from "vitest";
import { roleHome, STAFF_ROLES, ROLE_HOME } from "./roles";

describe("roleHome", () => {
  it("routes each staff role to its home", () => {
    expect(roleHome("OWNER")).toBe("/owner");
    expect(roleHome("ADVISOR")).toBe("/advisor");
    expect(roleHome("TECH")).toBe("/technician");
    expect(roleHome("CASHIER")).toBe("/cashier");
    // MASTER deliberately shares the advisor hub — it has no owner dashboard.
    expect(roleHome("MASTER")).toBe("/advisor");
  });

  it("maps the four core roles to distinct routes", () => {
    const core = ["OWNER", "ADVISOR", "TECH", "CASHIER"] as const;
    const homes = core.map(roleHome);
    expect(new Set(homes).size).toBe(core.length);
  });

  it("never routes MASTER to the owner dashboard", () => {
    expect(roleHome("MASTER")).not.toBe("/owner");
  });

  it("falls back to /login for unknown, null, or customer-ish roles", () => {
    expect(roleHome("CUSTOMER")).toBe("/login");
    expect(roleHome("")).toBe("/login");
    expect(roleHome(null)).toBe("/login");
    expect(roleHome(undefined)).toBe("/login");
  });

  it("has exactly the 5 staff roles", () => {
    expect(Object.keys(ROLE_HOME).sort()).toEqual(
      ["ADVISOR", "CASHIER", "MASTER", "OWNER", "TECH"],
    );
    expect(STAFF_ROLES).toHaveLength(5);
  });
});
