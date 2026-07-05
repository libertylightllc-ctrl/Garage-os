-- Inventory 2c (purchase returns). Additive only.

-- AlterTable: track how much of each line has been returned to the supplier.
-- 0 ≤ returnedQty ≤ receivedQty; each return increments it and drops stock.
-- Defaults 0 for existing rows (nothing returned yet).
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "returnedQty" INTEGER NOT NULL DEFAULT 0;
