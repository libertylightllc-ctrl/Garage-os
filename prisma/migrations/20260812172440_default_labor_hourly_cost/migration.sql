-- Shop-wide default labour hourly cost (AR 2026-08-12).
-- Nullable — legacy garages have no rate set yet. See schema comment
-- on Garage.defaultLaborHourlyCost for the rationale.
ALTER TABLE "Garage"
  ADD COLUMN "defaultLaborHourlyCost" DECIMAL(12, 2);
