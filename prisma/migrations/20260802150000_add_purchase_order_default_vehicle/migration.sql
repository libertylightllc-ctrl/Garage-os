-- Document-level default vehicle on PurchaseOrder. Same shape as the
-- per-line snapshot columns on PurchaseOrderLine (Layer 0), just
-- prefixed with `default`. Written at new-quotation / new-purchase-
-- order create; copied into each new PurchaseOrderLine at Add-line
-- write time so per-line snapshots stay the sole source of truth for
-- what the supplier saw.
--
-- Additive nullable columns — no data motion. Rollback is DROP
-- COLUMN * 8. Every existing row keeps behaving exactly as today
-- (default null = "no doc-level vehicle set").

ALTER TABLE "PurchaseOrder"
  ADD COLUMN "defaultVehicleId"         TEXT,
  ADD COLUMN "defaultVehicleMake"       TEXT,
  ADD COLUMN "defaultVehicleModel"      TEXT,
  ADD COLUMN "defaultVehicleYear"       INTEGER,
  ADD COLUMN "defaultVehiclePlate"      TEXT,
  ADD COLUMN "defaultVehicleVin"        TEXT,
  ADD COLUMN "defaultVehicleEngineSize" TEXT,
  ADD COLUMN "defaultVehicleFuelType"   TEXT;
