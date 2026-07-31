-- Intake disambiguation (slice 3). Two append-only audit tables + a
-- backfill of plate history for existing Vehicles whose plate is
-- populated. See the model comments in prisma/schema.prisma for the
-- design rationale and slice number.

-- ── VehiclePlateHistory ────────────────────────────────────────────
CREATE TABLE "VehiclePlateHistory" (
    "id"               TEXT      NOT NULL,
    "vehicleId"        TEXT      NOT NULL,
    "plate"            TEXT      NOT NULL,
    "normalizedPlate"  TEXT      NOT NULL,
    "attachedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt"       TIMESTAMP(3),
    "attachedByUserId" TEXT,
    "releasedByUserId" TEXT,
    CONSTRAINT "VehiclePlateHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VehiclePlateHistory_vehicleId_releasedAt_idx"
    ON "VehiclePlateHistory" ("vehicleId", "releasedAt");
CREATE INDEX "VehiclePlateHistory_normalizedPlate_releasedAt_idx"
    ON "VehiclePlateHistory" ("normalizedPlate", "releasedAt");

ALTER TABLE "VehiclePlateHistory"
    ADD CONSTRAINT "VehiclePlateHistory_vehicleId_fkey"
    FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehiclePlateHistory"
    ADD CONSTRAINT "VehiclePlateHistory_attachedByUserId_fkey"
    FOREIGN KEY ("attachedByUserId") REFERENCES "User" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VehiclePlateHistory"
    ADD CONSTRAINT "VehiclePlateHistory_releasedByUserId_fkey"
    FOREIGN KEY ("releasedByUserId") REFERENCES "User" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── VehicleOwnershipTransfer ───────────────────────────────────────
CREATE TABLE "VehicleOwnershipTransfer" (
    "id"                  TEXT      NOT NULL,
    "vehicleId"           TEXT      NOT NULL,
    "fromCustomerId"      TEXT      NOT NULL,
    "toCustomerId"        TEXT      NOT NULL,
    "transferredAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transferredByUserId" TEXT      NOT NULL,
    "previousOwnerName"   TEXT      NOT NULL,
    "previousOwnerPhone"  TEXT      NOT NULL,
    CONSTRAINT "VehicleOwnershipTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VehicleOwnershipTransfer_vehicleId_transferredAt_idx"
    ON "VehicleOwnershipTransfer" ("vehicleId", "transferredAt");

ALTER TABLE "VehicleOwnershipTransfer"
    ADD CONSTRAINT "VehicleOwnershipTransfer_vehicleId_fkey"
    FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleOwnershipTransfer"
    ADD CONSTRAINT "VehicleOwnershipTransfer_fromCustomerId_fkey"
    FOREIGN KEY ("fromCustomerId") REFERENCES "Customer" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VehicleOwnershipTransfer"
    ADD CONSTRAINT "VehicleOwnershipTransfer_toCustomerId_fkey"
    FOREIGN KEY ("toCustomerId") REFERENCES "Customer" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VehicleOwnershipTransfer"
    ADD CONSTRAINT "VehicleOwnershipTransfer_transferredByUserId_fkey"
    FOREIGN KEY ("transferredByUserId") REFERENCES "User" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Backfill VehiclePlateHistory ───────────────────────────────────
-- One row per existing Vehicle whose plate is populated. attachedAt =
-- Vehicle.createdAt, releasedAt = NULL (currently attached). Skip
-- Vehicles with a blank plate so we never store an empty-plate
-- history row; those Vehicles start their plate-history record
-- whenever a plate is next attached to them.
INSERT INTO "VehiclePlateHistory" (
    "id",
    "vehicleId",
    "plate",
    "normalizedPlate",
    "attachedAt"
)
SELECT
    'seed_' || v."id",
    v."id",
    v."plate",
    UPPER(REGEXP_REPLACE(v."plate", '[\s\-]', '', 'g')),
    v."createdAt"
FROM "Vehicle" v
WHERE v."plate" IS NOT NULL AND v."plate" <> '';
