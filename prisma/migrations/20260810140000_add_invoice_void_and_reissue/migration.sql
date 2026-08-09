-- Void + reissue for delivered invoices (2026-08-10).
--
-- A delivered invoice can't be edited — corrections happen by
-- voiding the original and issuing a fresh one at the next
-- sequential number. Both rows cross-reference each other so an
-- auditor can walk the trail in either direction:
--
--   INV-2026-0039 status=VOID, voidedAt=…, replacedBy → INV-2026-0040
--   INV-2026-0040 status=SENT, previousInvoiceId → INV-2026-0039
--
-- `previousInvoiceId` is @unique — one void can be replaced by
-- exactly one correction. Attempting a second correction against
-- the same void would violate the unique index and 500 the write,
-- which is what we want (the audit trail must be linear).
--
-- All additive, all nullable. No backfill needed.

ALTER TABLE "Invoice"
    ADD COLUMN "previousInvoiceId" TEXT,
    ADD COLUMN "voidedAt"          TIMESTAMP(3),
    ADD COLUMN "voidedByUserId"    TEXT;

-- @unique: one correction per void
CREATE UNIQUE INDEX "Invoice_previousInvoiceId_key"
    ON "Invoice"("previousInvoiceId");

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_previousInvoiceId_fkey"
    FOREIGN KEY ("previousInvoiceId") REFERENCES "Invoice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_voidedByUserId_fkey"
    FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
