-- Tech-tracking slice 1: time segments of a technician working one car.
-- endedAt IS NULL = the tech is on this car right now.
CREATE TABLE "WorkSession" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "jobCardId" TEXT NOT NULL,
    "techId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "WorkSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkSession_jobCardId_idx" ON "WorkSession"("jobCardId");
CREATE INDEX "WorkSession_techId_endedAt_idx" ON "WorkSession"("techId", "endedAt");
CREATE INDEX "WorkSession_garageId_endedAt_idx" ON "WorkSession"("garageId", "endedAt");

-- THE invariant: a tech can be on at most ONE car at a time. Partial
-- unique index (Prisma can't express it — hand-written on purpose; do
-- not let a future generated migration drop it).
CREATE UNIQUE INDEX "WorkSession_one_open_per_tech" ON "WorkSession"("techId") WHERE "endedAt" IS NULL;

ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_techId_fkey" FOREIGN KEY ("techId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
