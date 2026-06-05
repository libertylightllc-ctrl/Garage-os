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
