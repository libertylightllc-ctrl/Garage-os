-- AR 2026-08-25 Batch C — additive-only migration.
-- Schema shape: estimate restructure to match real UAE-shop format.
--   * SUBLET added to LineKind enum (outside work / consumables /
--     services). Existing PART/LABOR/FEE rows unchanged.
--   * Garage.defaultPaymentTerms — shop-wide default for the
--     Payment Terms block printed on every estimate.
--   * Estimate.paymentTerms — per-estimate override for the same.
--   * Estimate.remarks — per-estimate scope-limitation text.
--   * Estimate.advisorNameSnapshot + advisorPhoneSnapshot — captured
--     at Send time so a customer's copy of the doc still names the
--     right person after a staff change (same discipline as
--     InvoiceLine.unitCost being snapshotted at invoice-generation).

-- Postgres enum extension — additive, does not touch existing rows.
ALTER TYPE "LineKind" ADD VALUE 'SUBLET';

ALTER TABLE "Garage" ADD COLUMN "defaultPaymentTerms" TEXT;
ALTER TABLE "Estimate" ADD COLUMN "paymentTerms" TEXT;
ALTER TABLE "Estimate" ADD COLUMN "remarks" TEXT;
ALTER TABLE "Estimate" ADD COLUMN "advisorNameSnapshot" TEXT;
ALTER TABLE "Estimate" ADD COLUMN "advisorPhoneSnapshot" TEXT;
