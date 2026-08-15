-- Direct-fit receive (AR 2026-08-16). Two categories at goods
-- receipt: stock items (catalogue-linked, quantity into inventory,
-- Part.cost blended) OR direct-fit (bought for a specific job,
-- fitted, never enters stock). This migration adds the schema for
-- the direct-fit path. See docs/direct-fit-receive-spec.md.

-- Source-line back-link on PO lines. Populated on the from-estimate
-- flow so the direct-fit receive can (a) resolve the JobCard via
-- estimate → jobCard, and (b) update the source EstimateLine's
-- unitCost when the actual supplier cost differs (post-invoice
-- snapshots stay frozen). Nullable so manually-added POLines still
-- work; those can only take the stock path today.
ALTER TABLE "PurchaseOrderLine"
  ADD COLUMN "sourceEstimateLineId" TEXT;

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_sourceEstimateLineId_fkey"
  FOREIGN KEY ("sourceEstimateLineId")
  REFERENCES "EstimateLine"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "PurchaseOrderLine_sourceEstimateLineId_idx"
  ON "PurchaseOrderLine"("sourceEstimateLineId");

-- Direct-fit receipt ledger. Written ONLY by receivePurchaseOrderAction
-- when the operator chooses "Direct-fit" on an unlinked PO line.
-- Never touches Part or PartMovement (those are stock-only). See
-- schema comment on JobPartReceipt for the row-level semantics.
CREATE TABLE "JobPartReceipt" (
  "id"                  TEXT NOT NULL,
  "jobCardId"           TEXT NOT NULL,
  "purchaseOrderLineId" TEXT NOT NULL,
  "description"         TEXT NOT NULL,
  "qty"                 INTEGER NOT NULL,
  "receivedUnitCost"    DECIMAL(12,2) NOT NULL,
  "receivedPartNo"      TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "JobPartReceipt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "JobPartReceipt"
  ADD CONSTRAINT "JobPartReceipt_jobCardId_fkey"
  FOREIGN KEY ("jobCardId")
  REFERENCES "JobCard"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "JobPartReceipt"
  ADD CONSTRAINT "JobPartReceipt_purchaseOrderLineId_fkey"
  FOREIGN KEY ("purchaseOrderLineId")
  REFERENCES "PurchaseOrderLine"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

CREATE INDEX "JobPartReceipt_jobCardId_idx"
  ON "JobPartReceipt"("jobCardId");

CREATE INDEX "JobPartReceipt_purchaseOrderLineId_idx"
  ON "JobPartReceipt"("purchaseOrderLineId");
