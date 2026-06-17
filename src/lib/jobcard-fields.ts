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
 * One-line vehicle spec used wherever we need to tell the technician
 * or parts supplier exactly which car they're ordering for: the tech
 * job screen header and every part-request row. Format:
 *
 *   "Toyota Prado 2014 · 2.7 · Petrol"
 *
 * Each tail segment (year, engineSize, fuelType) is dropped if missing
 * so legacy vehicles (pre-spec-fields) still render the make/model
 * cleanly instead of leaving stray separators. fuelType is title-cased
 * because the stored value is the FUEL_TYPES enum (PETROL/DIESEL/...)
 * which looks shouty next to "Toyota".
 */
export function formatVehicleSpec(v: {
  make?: string | null;
  model?: string | null;
  year?: number | null;
  engineSize?: string | null;
  fuelType?: string | null;
}): string {
  const head = [v.make ?? "", v.model ?? ""].filter(Boolean).join(" ").trim();
  const tail = [
    v.year ? String(v.year) : null,
    v.engineSize && v.engineSize.trim() ? v.engineSize.trim() : null,
    v.fuelType ? titleCase(v.fuelType) : null,
  ].filter(Boolean) as string[];
  if (!head && tail.length === 0) return "";
  if (!head) return tail.join(" · ");
  if (tail.length === 0) return head;
  return `${head} · ${tail.join(" · ")}`;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Append "(Make Model)" to a part-line description. Retained for
 * backwards-compatibility with the table-rendering helpers below (and
 * for any future surface that still wants an inline label); idempotent
 * so re-applying is a no-op and missing data is safe.
 */
export function appendVehicleLabel(
  desc: string,
  make: string | null | undefined,
  model: string | null | undefined,
): string {
  const head = [make, model].filter(Boolean).join(" ").trim();
  if (!head) return desc;
  const suffix = `(${head})`;
  if (desc.toLowerCase().includes(suffix.toLowerCase())) return desc;
  return `${desc.trimEnd()} ${suffix}`;
}

/**
 * Inverse of appendVehicleLabel: returns the part-name without the
 * "(Make Model)" suffix, so a table column can render just "Oil filter"
 * while Make / Model live in their own cells. Strips a trailing
 * "(...)" segment that matches the vehicle make+model — case-insensitive
 * — and leaves the description alone if the suffix is something else
 * (e.g. the cashier typed their own parenthetical note).
 *
 *   stripVehicleLabel("Oil filter (Ford Focus)", "Ford", "Focus")
 *     → "Oil filter"
 *   stripVehicleLabel("Oil filter (OEM)", "Ford", "Focus")
 *     → "Oil filter (OEM)"     // not the vehicle label, untouched
 *   stripVehicleLabel("Oil filter", null, null)
 *     → "Oil filter"
 */
export function stripVehicleLabel(
  desc: string,
  make: string | null | undefined,
  model: string | null | undefined,
): string {
  const head = [make, model].filter(Boolean).join(" ").trim();
  if (!head) return desc;
  const pattern = new RegExp(
    `\\s*\\(\\s*${head.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\)\\s*$`,
    "i",
  );
  return desc.replace(pattern, "").trimEnd();
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
