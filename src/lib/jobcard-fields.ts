// Job-card Reception field helpers (Job-Card-Data-Model.md). Pure + dependency-free
// so the Job Card No formatting and checkbox sanitisation are testable.

/** Render the gapless per-garage number as JC-2026-0001 (null until assigned). */
export function formatJobNo(num: number | null | undefined, year: number): string | null {
  if (!num || num < 1) return null;
  return `JC-${year}-${String(num).padStart(4, "0")}`;
}

// Canonical checkbox / select values (labels are rendered via i18n in the UI).
export const EXTERIOR_OPTIONS = [
  "NO_DAMAGE",
  "SCRATCHES",
  "DENTS",
  "BROKEN_LIGHT",
  "CRACKED_WINDSHIELD",
] as const;
export const INTERIOR_OPTIONS = ["CLEAN", "DIRTY", "WARNING_LIGHT", "OTHER"] as const;
export const VALUABLES_OPTIONS = ["NONE", "DOCUMENTS", "CASH", "MOBILE_CHARGER", "OTHER"] as const;
export const OIL_TYPES = ["KM_5000", "KM_10000", "NONE"] as const;
export const FUEL_LEVELS = ["EMPTY", "QUARTER", "HALF", "THREE_QUARTER", "FULL"] as const;
// Fuel TYPE (engine fuel) — different from fuel LEVEL (tank fill). Driven by
// the new NHTSA VIN decode + manual selection on intake.
export const FUEL_TYPES = ["PETROL", "DIESEL", "HYBRID", "ELECTRIC", "OTHER"] as const;
// Quality-control checklist (Job-Card-Data-Model.md).
export const QC_CHECKS = ["REPAIR_COMPLETED", "ROAD_TEST", "NO_WARNING_LIGHTS", "VEHICLE_CLEANED"] as const;

/** Has QC been signed off? */
export function qcSignedOff(qcAt: Date | null | undefined): boolean {
  return !!qcAt;
}

/** Keep only allowed values (drops anything unexpected, de-duplicates). */
export function sanitizeChoices(values: string[], allowed: readonly string[]): string[] {
  const ok = new Set(allowed);
  return [...new Set(values)].filter((v) => ok.has(v));
}

/** Coerce a form value to a valid OilType (defaults to NONE). */
export function toOilType(v: string): (typeof OIL_TYPES)[number] {
  return (OIL_TYPES as readonly string[]).includes(v) ? (v as (typeof OIL_TYPES)[number]) : "NONE";
}

/** Coerce a form value to a valid FuelLevel, or null if unset/invalid. */
export function toFuelLevel(v: string): (typeof FUEL_LEVELS)[number] | null {
  return (FUEL_LEVELS as readonly string[]).includes(v) ? (v as (typeof FUEL_LEVELS)[number]) : null;
}

/** Coerce a form value to a valid FuelType, or null if unset/invalid. */
export function toFuelType(v: string): (typeof FUEL_TYPES)[number] | null {
  return (FUEL_TYPES as readonly string[]).includes(v) ? (v as (typeof FUEL_TYPES)[number]) : null;
}

/**
 * VIN validation — strict per ISO 3779:
 *   - Exactly 17 alphanumeric characters
 *   - Letters I, O, Q are not allowed (visually ambiguous with 1, 0, 0)
 *
 * Returns the normalized (uppercase) VIN when valid, or null otherwise.
 * Caller should null-check before submitting to NHTSA — invalid VINs
 * waste a network round trip and return garbage.
 */
export function normalizeVin(raw: string): string | null {
  const v = raw.trim().toUpperCase();
  if (v.length !== 17) return null;
  // Allowed: A-H, J-N, P, R-Z, 0-9. Exclude I, O, Q.
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return null;
  return v;
}

export function isValidVin(raw: string): boolean {
  return normalizeVin(raw) !== null;
}

/**
 * Map NHTSA's free-text "FuelTypePrimary" string to our internal
 * FuelType enum. NHTSA returns values like "Gasoline", "Diesel",
 * "Electric", "Hybrid", or empty string. Empty input → null (caller
 * preserves the existing value rather than wiping it).
 */
export function nhtsaFuelToInternal(v: string | undefined | null): (typeof FUEL_TYPES)[number] | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s.includes("electric") && !s.includes("hybrid")) return "ELECTRIC";
  if (s.includes("hybrid")) return "HYBRID";
  if (s.includes("diesel")) return "DIESEL";
  if (s.includes("gasoline") || s.includes("petrol")) return "PETROL";
  return "OTHER";
}
