-- AR 2026-08-27 — ERPNext sync Phase 1 (state tables only).
--
-- See ERPNEXT_SYNC_BRIEF.md for the operative brief. Phase 1 adds:
--   - Garage.erpSyncEnabled — per-garage kill-switch, default false
--   - ErpEntityMap — idempotency spine (garageosId ↔ erpnextName)
--   - ErpSyncJob — per-op queue row, tailer inserts / runner consumes
--   - ErpSyncCursor — one row per garage, monotonic (createdAt, id)
--
-- Nothing else touches this schema until Phase 2 wires the tailer.
-- Constraint 3 of the brief (§1) — additive only. No existing table,
-- column, index, trigger, or query is modified.

-- ---------- Enums ----------
CREATE TYPE "ErpSyncOp" AS ENUM (
    'PUSH_CUSTOMER',
    'PUSH_ITEM',
    'PUSH_INVOICE',
    'PUSH_PAYMENT',
    'PUSH_ADVANCE',
    'PUSH_VOID',
    'APPLY_DEPOSIT'
);

CREATE TYPE "ErpSyncJobStatus" AS ENUM (
    'PENDING',
    'RUNNING',
    'SYNCED',
    'FAILED',
    'DEAD_LETTER'
);

-- ---------- Garage kill-switch ----------
ALTER TABLE "Garage" ADD COLUMN "erpSyncEnabled" BOOLEAN NOT NULL DEFAULT false;

-- ---------- ErpEntityMap ----------
CREATE TABLE "ErpEntityMap" (
    "id"              TEXT NOT NULL,
    "garageId"        TEXT NOT NULL,
    "garageosDoctype" TEXT NOT NULL,
    "garageosId"      TEXT NOT NULL,
    "erpnextDoctype"  TEXT NOT NULL,
    "erpnextName"     TEXT NOT NULL,
    "version"         INTEGER NOT NULL DEFAULT 1,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpEntityMap_pkey" PRIMARY KEY ("id")
);

-- Load-bearing uniqueness: a duplicate push on either side fails at
-- the DB rather than silently creating a second record.
CREATE UNIQUE INDEX "ErpEntityMap_garageId_garageosDoctype_garageosId_key"
    ON "ErpEntityMap" ("garageId", "garageosDoctype", "garageosId");
CREATE UNIQUE INDEX "ErpEntityMap_garageId_erpnextDoctype_erpnextName_key"
    ON "ErpEntityMap" ("garageId", "erpnextDoctype", "erpnextName");
CREATE INDEX "ErpEntityMap_garageId_garageosDoctype_idx"
    ON "ErpEntityMap" ("garageId", "garageosDoctype");

ALTER TABLE "ErpEntityMap" ADD CONSTRAINT "ErpEntityMap_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- ErpSyncJob ----------
CREATE TABLE "ErpSyncJob" (
    "id"              TEXT NOT NULL,
    "garageId"        TEXT NOT NULL,
    "op"              "ErpSyncOp" NOT NULL,
    "sourceType"      TEXT NOT NULL,
    "sourceId"        TEXT NOT NULL,
    "dependsOnJobIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status"          "ErpSyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts"        INTEGER NOT NULL DEFAULT 0,
    "lastError"       TEXT,
    "lastErrorField"  TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "syncedAt"        TIMESTAMP(3),

    CONSTRAINT "ErpSyncJob_pkey" PRIMARY KEY ("id")
);

-- Tailer idempotency: re-scanning the same cursor window on retry
-- cannot double-enqueue.
CREATE UNIQUE INDEX "ErpSyncJob_garageId_op_sourceId_key"
    ON "ErpSyncJob" ("garageId", "op", "sourceId");
CREATE INDEX "ErpSyncJob_garageId_status_createdAt_idx"
    ON "ErpSyncJob" ("garageId", "status", "createdAt");
CREATE INDEX "ErpSyncJob_status_createdAt_idx"
    ON "ErpSyncJob" ("status", "createdAt");

ALTER TABLE "ErpSyncJob" ADD CONSTRAINT "ErpSyncJob_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- ErpSyncCursor ----------
-- One row per garage. Compound cursor over LedgerEntry (createdAt, id)
-- because LedgerEntry.id is a cuid — lexicographically sortable but
-- not strictly monotonic across concurrent inserts within the same
-- millisecond. Query shape lives in Phase 2 (tailer).
CREATE TABLE "ErpSyncCursor" (
    "garageId"            TEXT NOT NULL,
    -- Non-null with no DB default: the tailer upserts on first pass
    -- per garage with lastLedgerCreatedAt = 1970-01-01, lastLedgerId
    -- = ''. Explicit app-side initialization avoids Prisma
    -- introspection drift on the cursor's default expression.
    "lastLedgerCreatedAt" TIMESTAMP(3) NOT NULL,
    "lastLedgerId"        TEXT NOT NULL,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpSyncCursor_pkey" PRIMARY KEY ("garageId")
);

ALTER TABLE "ErpSyncCursor" ADD CONSTRAINT "ErpSyncCursor_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
