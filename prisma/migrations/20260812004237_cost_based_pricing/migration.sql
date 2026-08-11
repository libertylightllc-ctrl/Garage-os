-- Cost-based estimate pricing (AR 2026-08-12).
--
-- Three nullable additions; no backfill required. Existing rows keep
-- unitPrice + lineTotal untouched. Advisors see the new inputs only
-- on new / edited lines; historical estimates render unchanged.
--
-- Decimal(5, 2) on markup gives us 0.00–999.99 %, well past any
-- realistic parts margin. Decimal(12, 2) on unitCost matches
-- unitPrice — same currency precision.

ALTER TABLE "EstimateLine"
  ADD COLUMN "unitCost"  DECIMAL(12, 2),
  ADD COLUMN "markupPct" DECIMAL(5, 2);

ALTER TABLE "InvoiceLine"
  ADD COLUMN "unitCost" DECIMAL(12, 2);

ALTER TABLE "Garage"
  ADD COLUMN "defaultPartsMarkupPct" DECIMAL(5, 2);
