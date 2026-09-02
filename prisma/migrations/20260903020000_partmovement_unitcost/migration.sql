-- AR 2026-09-03 — E6, PartMovement.unitCost for the purchase summary.
--
-- Nullable additive column. Only meaningful for kind='PO_RECEIPT'
-- (or 'PO_RETURN' reversal). The writer path (receivePurchaseOrderAction)
-- populates it inside the same tx that creates the PartMovement row;
-- historical rows stay null and read as "unknown cost" on the
-- purchase summary, surfaced via a coverage note.
--
-- No backfill: 2 historical PO_RECEIPT rows on Prod at cutover, both
-- on Demo. Inventing a cost via PoLine.unitCost lookup would produce
-- a number the operator didn't assert at the time — same cutover
-- discipline rule 14 pins for emirate.

ALTER TABLE "PartMovement" ADD COLUMN "unitCost" DECIMAL(12, 2);
