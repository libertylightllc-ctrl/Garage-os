-- Short-lived scratch record for the Moulkia OCR pipeline. Holds
-- the extracted owner + vehicle fields server-side across the
-- front → back → confirm hops so nothing sensitive travels through
-- URL query params. Only an opaque cuid rides through the URL; the
-- garage-scoped read on every load provides the capability model.
CREATE TABLE "IntakeDraft" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "ownerName" TEXT,
    "plate" TEXT,
    "vin" TEXT,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "engineSize" TEXT,
    "fuelType" TEXT,
    "assignedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntakeDraft_pkey" PRIMARY KEY ("id")
);

-- Cascade the delete: if a garage row goes away, its draft rows are
-- meaningless. createdByUser is a hard FK — a draft always has a
-- creator on record.
ALTER TABLE "IntakeDraft" ADD CONSTRAINT "IntakeDraft_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntakeDraft" ADD CONSTRAINT "IntakeDraft_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Read path: (garageId, expiresAt) covers the garage-scoped
-- findFirst-with-not-expired plus the stale-sweep at the top of
-- moulkiaFrontAction (scoped to the current garage).
CREATE INDEX "IntakeDraft_garageId_expiresAt_idx"
    ON "IntakeDraft"("garageId", "expiresAt");

-- Safety net for a future cross-garage cleanup job. Not exercised by
-- any code path today; here so a maintenance sweep never has to add
-- an index against an already-populated table.
CREATE INDEX "IntakeDraft_expiresAt_idx" ON "IntakeDraft"("expiresAt");
