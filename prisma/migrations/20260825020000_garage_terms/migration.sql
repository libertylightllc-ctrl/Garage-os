-- AR 2026-08-25 Batch D — additive-only migration.
-- Adds Garage.terms — shop-wide Terms & Conditions block printed at
-- the bottom of every estimate and invoice. Free text, nullable, no
-- default (garages must set their own — we do not ship boilerplate
-- terms because terms are legally the shop's own document).

ALTER TABLE "Garage" ADD COLUMN "terms" TEXT;
