import { describe, it, expect } from "vitest";
import {
  formatJobNo,
  sanitizeChoices,
  toOilType,
  toFuelLevel,
  toFuelType,
  normalizeVin,
  isValidVin,
  nhtsaFuelToInternal,
  formatVehicleSpec,
  qcSignedOff,
  EXTERIOR_OPTIONS,
  VALUABLES_OPTIONS,
  QC_CHECKS,
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

  it("sanitizes QC checks to the allowed set", () => {
    expect(sanitizeChoices(["ROAD_TEST", "NOPE", "ROAD_TEST"], QC_CHECKS)).toEqual(["ROAD_TEST"]);
    expect(sanitizeChoices([...QC_CHECKS], QC_CHECKS)).toHaveLength(4);
  });

  it("qcSignedOff reflects the timestamp", () => {
    expect(qcSignedOff(new Date())).toBe(true);
    expect(qcSignedOff(null)).toBe(false);
    expect(qcSignedOff(undefined)).toBe(false);
  });

  // ── Fuel type + VIN slice ──────────────────────────────────────────
  it("coerces fuel type, null when unset/invalid", () => {
    expect(toFuelType("PETROL")).toBe("PETROL");
    expect(toFuelType("DIESEL")).toBe("DIESEL");
    expect(toFuelType("HYBRID")).toBe("HYBRID");
    expect(toFuelType("ELECTRIC")).toBe("ELECTRIC");
    expect(toFuelType("OTHER")).toBe("OTHER");
    expect(toFuelType("")).toBeNull();
    expect(toFuelType("gas")).toBeNull();
  });

  it("normalizeVin enforces 17 chars + allowed alphabet", () => {
    // Real VINs from the task spec.
    expect(normalizeVin("WF0BB2KF1ELY11017")).toBe("WF0BB2KF1ELY11017");
    expect(normalizeVin("1HGCM82633A004352")).toBe("1HGCM82633A004352");
    // Uppercases + trims input.
    expect(normalizeVin("  wf0bb2kf1ely11017  ")).toBe("WF0BB2KF1ELY11017");
    // Wrong length.
    expect(normalizeVin("1HGCM82633")).toBeNull();
    expect(normalizeVin("1HGCM82633A0043521")).toBeNull();
    // Empty.
    expect(normalizeVin("")).toBeNull();
    // Contains forbidden I / O / Q (ISO 3779 — avoid 1/0 confusion).
    expect(normalizeVin("1HGCM82633A00435I")).toBeNull();
    expect(normalizeVin("1HGCM82633A00435O")).toBeNull();
    expect(normalizeVin("1HGCM82633A00435Q")).toBeNull();
    // Non-alphanumeric.
    expect(normalizeVin("1HGCM82633A00435-")).toBeNull();
  });

  it("isValidVin is the boolean wrapper", () => {
    expect(isValidVin("1HGCM82633A004352")).toBe(true);
    expect(isValidVin("nope")).toBe(false);
  });

  it("nhtsaFuelToInternal maps free-text NHTSA values to our enum", () => {
    // NHTSA's actual values (FuelTypePrimary):
    expect(nhtsaFuelToInternal("Gasoline")).toBe("PETROL");
    expect(nhtsaFuelToInternal("gasoline")).toBe("PETROL");
    expect(nhtsaFuelToInternal("Diesel")).toBe("DIESEL");
    expect(nhtsaFuelToInternal("Electric")).toBe("ELECTRIC");
    expect(nhtsaFuelToInternal("Hybrid Electric Vehicle")).toBe("HYBRID");
    expect(nhtsaFuelToInternal("Plug-in Hybrid Electric")).toBe("HYBRID");
    // Compressed Natural Gas etc — falls back to OTHER so the field is
    // still meaningful rather than silently dropped.
    expect(nhtsaFuelToInternal("Compressed Natural Gas (CNG)")).toBe("OTHER");
    // Empty / null / undefined → null so the caller preserves the
    // existing field value (the OCR-friendly rule from the spec).
    expect(nhtsaFuelToInternal("")).toBeNull();
    expect(nhtsaFuelToInternal(null)).toBeNull();
    expect(nhtsaFuelToInternal(undefined)).toBeNull();
  });

  // ── Vehicle spec slice ─────────────────────────────────────────────
  // The technician / parts surfaces need a stable, locale-safe one-liner
  // for "Toyota Prado 2014 · 2.7 · Petrol". Each tail field must drop
  // gracefully so legacy vehicles still render the head cleanly.
  it("formatVehicleSpec renders the canonical one-liner", () => {
    expect(
      formatVehicleSpec({
        make: "Toyota",
        model: "Prado",
        year: 2014,
        engineSize: "2.7",
        fuelType: "PETROL",
      }),
    ).toBe("Toyota Prado · 2014 · 2.7 · Petrol");
  });

  it("formatVehicleSpec omits missing tail fields without leaving stray separators", () => {
    expect(
      formatVehicleSpec({ make: "Toyota", model: "Prado", year: 2014 }),
    ).toBe("Toyota Prado · 2014");
    expect(formatVehicleSpec({ make: "Toyota", model: "Prado" })).toBe("Toyota Prado");
    // Legacy row with neither year nor spec.
    expect(formatVehicleSpec({ make: "Nissan", model: "Patrol" })).toBe("Nissan Patrol");
    // Engine but no fuel — fine.
    expect(
      formatVehicleSpec({ make: "Toyota", model: "Prado", engineSize: "2.7" }),
    ).toBe("Toyota Prado · 2.7");
  });

  it("formatVehicleSpec handles partial / empty input gracefully", () => {
    expect(formatVehicleSpec({})).toBe("");
    expect(formatVehicleSpec({ make: null, model: null })).toBe("");
    // Whitespace-only engineSize is treated as missing.
    expect(
      formatVehicleSpec({ make: "Toyota", model: "Prado", engineSize: "   " }),
    ).toBe("Toyota Prado");
  });

  it("formatVehicleSpec title-cases the fuelType enum value", () => {
    expect(
      formatVehicleSpec({ make: "Nissan", model: "Patrol", fuelType: "DIESEL" }),
    ).toBe("Nissan Patrol · Diesel");
    expect(
      formatVehicleSpec({ make: "Toyota", model: "Camry", fuelType: "HYBRID" }),
    ).toBe("Toyota Camry · Hybrid");
  });
});
