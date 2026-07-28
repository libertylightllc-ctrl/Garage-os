-- Add vehicle-assignment fields to PurchaseOrderLine (snapshot pattern).
--
-- vehicleId is a real FK for history/reporting; the 7 snapshot columns
-- carry the frozen-at-write display data so a later Vehicle edit does
-- NOT retroactively change a sent supplier document.
--
-- Backfill: for existing rows, resolve via the Part.autoCreatedFromLineId
-- chain (Part → EstimateLine → Estimate → JobCard → Vehicle) and populate
-- both vehicleId and the snapshot columns. Rows that don't resolve stay
-- null (unchanged display behaviour).

ALTER TABLE "PurchaseOrderLine"
  ADD COLUMN "vehicleId"         TEXT,
  ADD COLUMN "vehicleMake"       TEXT,
  ADD COLUMN "vehicleModel"      TEXT,
  ADD COLUMN "vehicleYear"       INTEGER,
  ADD COLUMN "vehicleEngineSize" TEXT,
  ADD COLUMN "vehicleFuelType"   TEXT,
  ADD COLUMN "vehicleVin"        TEXT,
  ADD COLUMN "vehiclePlate"      TEXT,
  ADD COLUMN "vehicleJobNumber"  INTEGER;

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PurchaseOrderLine_vehicleId_idx"
  ON "PurchaseOrderLine"("vehicleId");

-- Backfill from the existing chain. Only rows where the chain fully
-- resolves get populated; the rest stay null.
--
-- Idempotency: `pol."vehicleId" IS NULL` guard means re-running (during
-- recovery, a snapshot-restore replay, or a manual re-apply) will not
-- overwrite a snapshot the advisor has since corrected. Once populated,
-- the row is frozen and only the advisor's own edits touch it.
UPDATE "PurchaseOrderLine" pol
SET
  "vehicleId"         = v.id,
  "vehicleMake"       = v.make,
  "vehicleModel"      = v.model,
  "vehicleYear"       = v.year,
  "vehicleEngineSize" = v."engineSize",
  "vehicleFuelType"   = v."fuelType",
  "vehicleVin"        = v.vin,
  "vehiclePlate"      = v.plate,
  "vehicleJobNumber"  = jc.number
FROM "Part" p
JOIN "EstimateLine" el ON el.id = p."autoCreatedFromLineId"
JOIN "Estimate"     e  ON e.id  = el."estimateId"
JOIN "JobCard"      jc ON jc.id = e."jobCardId"
JOIN "Vehicle"      v  ON v.id  = jc."vehicleId"
WHERE pol."partId" = p.id
  AND p."autoCreatedFromLineId" IS NOT NULL
  AND jc.number IS NOT NULL
  AND pol."vehicleId" IS NULL
  AND pol."vehicleMake" IS NULL
  AND pol."vehicleModel" IS NULL
  AND pol."vehiclePlate" IS NULL;
