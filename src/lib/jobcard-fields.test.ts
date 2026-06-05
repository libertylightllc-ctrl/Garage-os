import { describe, it, expect } from "vitest";
import {
  formatJobNo,
  sanitizeChoices,
  toOilType,
  toFuelLevel,
  EXTERIOR_OPTIONS,
  VALUABLES_OPTIONS,
} from "./jobcard-fields";

describe("job-card reception helpers", () => {
  it("formats the Job Card No with zero-padding", () => {
    expect(formatJobNo(1, 2026)).toBe("JC-2026-0001");
    expect(formatJobNo(42, 2026)).toBe("JC-2026-0042");
    expect(formatJobNo(12345, 2026)).toBe("JC-2026-12345");
  });

  it("returns null when no number is assigned", () => {
    expect(formatJobNo(null, 2026)).toBeNull();
    expect(formatJobNo(0, 2026)).toBeNull();
    expect(formatJobNo(undefined, 2026)).toBeNull();
  });

  it("sanitizes checkbox values to the allowed set, de-duplicated", () => {
    expect(sanitizeChoices(["SCRATCHES", "DENTS", "HACK", "SCRATCHES"], EXTERIOR_OPTIONS)).toEqual([
      "SCRATCHES",
      "DENTS",
    ]);
    expect(sanitizeChoices(["NONE", "CASH"], VALUABLES_OPTIONS)).toEqual(["NONE", "CASH"]);
    expect(sanitizeChoices([], EXTERIOR_OPTIONS)).toEqual([]);
    expect(sanitizeChoices(["nope"], EXTERIOR_OPTIONS)).toEqual([]);
  });

  it("coerces oil type, defaulting to NONE", () => {
    expect(toOilType("KM_5000")).toBe("KM_5000");
    expect(toOilType("KM_10000")).toBe("KM_10000");
    expect(toOilType("")).toBe("NONE");
    expect(toOilType("garbage")).toBe("NONE");
  });

  it("coerces fuel level, null when unset/invalid", () => {
    expect(toFuelLevel("FULL")).toBe("FULL");
    expect(toFuelLevel("HALF")).toBe("HALF");
    expect(toFuelLevel("")).toBeNull();
    expect(toFuelLevel("x")).toBeNull();
  });
});
