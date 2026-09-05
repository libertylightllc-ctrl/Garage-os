-- AR 2026-09-03 — E7 (QuickBooks-migration import) schema foundation.
--
-- Two tables + two enums for the preview-then-commit CSV import
-- pipeline. LedgerImportBatch is the one row per uploaded file;
-- LedgerImportError is the one row per rejected line.
--
-- The parse action writes a DRAFT batch with the parsed rows in
-- parsedRowsJson and a preview summary in previewSummaryJson. The
-- commit action reads the same batch, applies per-row idempotent
-- inserts, and stamps committedAt/committedByUserId. A browser
-- reload between preview and commit doesn't lose the parsed data —
-- the batch is the source of truth.
--
-- No delete-guard triggers today. LedgerImportBatch is an audit
-- surface, not itself a ledger writer — the ledger rows produced
-- by an opening-balance commit carry sourceType='OPENING_BALANCE'
-- and stand on their own. A future audit-hardening phase may add
-- a guard.

CREATE TYPE "LedgerImportKind" AS ENUM (
    'CUSTOMER',
    'VENDOR',
    'ITEM',
    'OPENING_BALANCE'
);

CREATE TYPE "LedgerImportStatus" AS ENUM (
    'DRAFT',
    'COMMITTED',
    'DISCARDED'
);

CREATE TABLE "LedgerImportBatch" (
    "id"                   TEXT PRIMARY KEY,
    "garageId"             TEXT NOT NULL,
    "uploadedByUserId"     TEXT NOT NULL,
    "kind"                 "LedgerImportKind" NOT NULL,
    "status"               "LedgerImportStatus" NOT NULL DEFAULT 'DRAFT',
    "fileName"             TEXT NOT NULL,
    "parsedRowsJson"       JSONB NOT NULL,
    "previewSummaryJson"   JSONB NOT NULL,
    "committedAt"          TIMESTAMP(3),
    "committedByUserId"    TEXT,
    "discardedAt"          TIMESTAMP(3),
    "note"                 TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerImportBatch_garageId_fkey"
        FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT,
    CONSTRAINT "LedgerImportBatch_uploadedByUserId_fkey"
        FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT,
    CONSTRAINT "LedgerImportBatch_committedByUserId_fkey"
        FOREIGN KEY ("committedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT
);

CREATE INDEX "LedgerImportBatch_garageId_status_idx"
    ON "LedgerImportBatch" ("garageId", "status");
CREATE INDEX "LedgerImportBatch_garageId_kind_idx"
    ON "LedgerImportBatch" ("garageId", "kind");
CREATE INDEX "LedgerImportBatch_uploadedByUserId_idx"
    ON "LedgerImportBatch" ("uploadedByUserId");

CREATE TABLE "LedgerImportError" (
    "id"        TEXT PRIMARY KEY,
    "batchId"   TEXT NOT NULL,
    "rowIndex"  INTEGER NOT NULL,
    "rowJson"   JSONB NOT NULL,
    "reason"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerImportError_batchId_fkey"
        FOREIGN KEY ("batchId") REFERENCES "LedgerImportBatch"("id") ON DELETE CASCADE
);

CREATE INDEX "LedgerImportError_batchId_idx"
    ON "LedgerImportError" ("batchId");
