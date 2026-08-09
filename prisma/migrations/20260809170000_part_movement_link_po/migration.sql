-- PartMovement gains an explicit garageId, a nullable purchaseOrderId
-- FK, and a `kind` enum. Free-text `reason` stays as a human note.
--
-- Rollout order:
--   1. Create the enum.
--   2. Add columns nullable + kind DEFAULT MANUAL_ADJUSTMENT (safe
--      for historical rows we can't reclassify from truncated
--      reason strings).
--   3. Backfill garageId from Part → Customer would be one join, but
--      Part carries garageId directly, so use that.
--   4. NOT NULL garageId once backfilled.
--   5. Add FKs + indexes.

CREATE TYPE "PartMovementKind" AS ENUM (
    'PO_RECEIPT',
    'PO_RETURN',
    'MANUAL_ADJUSTMENT',
    'GOODS_ISSUE'
);

ALTER TABLE "PartMovement"
    ADD COLUMN "garageId" TEXT,
    ADD COLUMN "purchaseOrderId" TEXT,
    ADD COLUMN "kind" "PartMovementKind" NOT NULL DEFAULT 'MANUAL_ADJUSTMENT';

-- Backfill garageId from the movement's Part row. Part.garageId is
-- NOT NULL so this backfill covers every row.
UPDATE "PartMovement" pm
SET "garageId" = p."garageId"
FROM "Part" p
WHERE pm."partId" = p."id";

-- Now safe to NOT NULL. Any INSERT after this migration MUST set it
-- (both writers already updated in the same commit).
ALTER TABLE "PartMovement"
    ALTER COLUMN "garageId" SET NOT NULL;

ALTER TABLE "PartMovement"
    ADD CONSTRAINT "PartMovement_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PartMovement"
    ADD CONSTRAINT "PartMovement_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PartMovement_garageId_idx" ON "PartMovement"("garageId");
CREATE INDEX "PartMovement_purchaseOrderId_idx" ON "PartMovement"("purchaseOrderId");
