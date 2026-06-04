import { describe, it, expect } from "vitest";
import {
  REMINDER_TYPES,
  REMINDER_MONTHS,
  addMonths,
  dueDateFor,
  isDue,
  reminderBody,
} from "./reminders";

describe("maintenance reminders", () => {
  it("uses the spec-exact intervals", () => {
    expect(REMINDER_MONTHS.OIL_5000).toBe(2);
    expect(REMINDER_MONTHS.OIL_10000).toBe(4);
    expect(REMINDER_MONTHS.BATTERY).toBe(6);
    expect(REMINDER_MONTHS.TIRE_ROTATION).toBe(6);
    expect(REMINDER_MONTHS.BRAKES).toBe(6);
    expect(REMINDER_MONTHS.AC_SERVICE).toBe(6);
    expect(REMINDER_MONTHS.AIR_FILTER).toBe(12);
    expect(REMINDER_MONTHS.COOLANT).toBe(12);
    expect(REMINDER_MONTHS.TRANSMISSION).toBe(12);
  });

  it("has an interval and a message for every type", () => {
    for (const type of REMINDER_TYPES) {
      expect(typeof REMINDER_MONTHS[type]).toBe("number");
      expect(reminderBody(type, "Toyota Land Cruiser", "en").length).toBeGreaterThan(0);
      expect(reminderBody(type, "Toyota Land Cruiser", "ar").length).toBeGreaterThan(0);
    }
  });

  it("addMonths does not mutate the input", () => {
    const base = new Date("2026-01-15T00:00:00.000Z");
    const out = addMonths(base, 2);
    expect(base.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(out.getMonth()).toBe(2); // March (0-indexed)
  });

  it("computes due dates from the service date", () => {
    const service = new Date("2026-01-10T00:00:00.000Z");
    expect(dueDateFor("OIL_5000", service).getMonth()).toBe(2); // +2 → March
    expect(dueDateFor("OIL_10000", service).getMonth()).toBe(4); // +4 → May
    expect(dueDateFor("AIR_FILTER", service).getFullYear()).toBe(2027); // +12 → next year
  });

  it("isDue compares against now", () => {
    const now = new Date("2026-06-04T00:00:00.000Z");
    expect(isDue(new Date("2026-06-03T00:00:00.000Z"), now)).toBe(true);
    expect(isDue(new Date("2026-06-04T00:00:00.000Z"), now)).toBe(true); // exactly now
    expect(isDue(new Date("2026-06-05T00:00:00.000Z"), now)).toBe(false);
  });

  it("oil reminders cite the km figure and ask to check mileage", () => {
    const en = reminderBody("OIL_5000", "Nissan Patrol", "en");
    expect(en).toMatch(/5,000 km/);
    expect(en.toLowerCase()).toContain("check your mileage");

    const en10 = reminderBody("OIL_10000", "Nissan Patrol", "en");
    expect(en10).toMatch(/10,000 km/);

    const ar = reminderBody("OIL_5000", "Nissan Patrol", "ar");
    expect(ar).toContain("5,000");
  });

  it("non-oil reminders still ask to check mileage", () => {
    const en = reminderBody("BATTERY", "Honda Accord", "en");
    expect(en.toLowerCase()).toContain("check your mileage");
  });

  it("falls back to English for unsupported languages", () => {
    const hi = reminderBody("BRAKES", "Kia Sportage", "hi" as never);
    expect(hi.toLowerCase()).toContain("brake check");
  });
});
