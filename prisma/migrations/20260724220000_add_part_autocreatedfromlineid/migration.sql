-- Estimate → PO auto-create (2026-07-24). Optional back-reference from
-- Part to the EstimateLine it was auto-created from. Nullable so all
-- existing rows are valid; @unique so re-running the from-estimate
-- flow on the same line links to the existing Part instead of
-- duplicating.

ALTER TABLE "Part" ADD COLUMN "autoCreatedFromLineId" TEXT;

CREATE UNIQUE INDEX "Part_autoCreatedFromLineId_key"
  ON "Part"("autoCreatedFromLineId");

ALTER TABLE "Part"
  ADD CONSTRAINT "Part_autoCreatedFromLineId_fkey"
  FOREIGN KEY ("autoCreatedFromLineId") REFERENCES "EstimateLine"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
