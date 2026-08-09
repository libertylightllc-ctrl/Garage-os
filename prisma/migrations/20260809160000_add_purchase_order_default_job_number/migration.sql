-- Doc-level default job card number on PurchaseOrder — pairs with the
-- existing default_vehicle_* columns and mirrors PurchaseOrderLine's
-- own vehicleJobNumber column. Snapshot only, nullable, additive.

ALTER TABLE "PurchaseOrder"
    ADD COLUMN "defaultVehicleJobNumber" INTEGER;
