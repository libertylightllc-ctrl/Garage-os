-- Inventory 2b (partial receiving). Additive only.

-- AlterEnum: a PO can now be partially received (some qty in, more outstanding).
ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'PARTIALLY_RECEIVED';

-- AlterTable: track how much of each line has been received so far.
-- 0 ≤ receivedQty ≤ qty; each receipt increments it. Defaults 0 for
-- existing rows (nothing received yet).
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "receivedQty" INTEGER NOT NULL DEFAULT 0;
