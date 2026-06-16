-- Intake: add fuelType column to JobCard.
-- Optional / nullable, no default — pre-existing rows keep NULL.
-- Values: 'PETROL' | 'DIESEL' | 'HYBRID' | 'ELECTRIC' | 'OTHER'
-- Stored as String (not enum) so we can add 'FLEX_FUEL' / 'CNG' /
-- 'HYDROGEN' later without a destructive schema migration.

ALTER TABLE "JobCard" ADD COLUMN "fuelType" TEXT;
