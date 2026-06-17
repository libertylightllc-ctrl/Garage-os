-- Add intrinsic vehicle spec fields. engineSize is free text ("2.7", "5.7L",
-- "2.0T") because NHTSA returns decimal liters but advisors may type variants.
-- fuelType mirrors the JobCard column it backfills from (PETROL | DIESEL |
-- HYBRID | ELECTRIC | OTHER) — kept as TEXT, not an enum, so the existing
-- FUEL_TYPES const in src/lib/jobcard-fields.ts remains the single source of
-- truth without coupling the schema to a Postgres enum we'd need to migrate.
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "engineSize" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "fuelType"   TEXT;
