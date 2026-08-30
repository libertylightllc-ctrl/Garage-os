-- AR 2026-08-30 — Payables phase 1 (schema commit).
--
-- Full-accrual supplier side: goods receipt will (in a later commit)
-- auto-create a SupplierBill and post DR Inventory / CR AP. Supplier
-- payments allocate across one or more open bills (no on-account
-- balances) and post DR AP / CR Cash per allocation. Bill void with
-- allocated payments is blocked at the app; row DELETE on any of
-- these tables is blocked at the DB by triggers in the next
-- migration (Payables C2 — 20260830010000_payables_delete_guard).
--
-- Additive only. No existing table changed except Garage gaining
-- billSeq (the per-garage gapless SupplierBill counter, same
-- discipline as invoiceSeq / jobSeq).

-- Per-garage bill counter.
ALTER TABLE "Garage"
    ADD COLUMN "billSeq" INTEGER NOT NULL DEFAULT 0;

-- Bill lifecycle.
CREATE TYPE "SupplierBillStatus" AS ENUM (
    'OPEN',
    'PARTIALLY_PAID',
    'PAID',
    'VOID'
);

-- ─── SupplierBill ────────────────────────────────────────────────
CREATE TABLE "SupplierBill" (
    "id"              TEXT NOT NULL,
    "garageId"        TEXT NOT NULL,
    "supplierId"      TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "billNumber"      INTEGER NOT NULL,
    "billDate"        TIMESTAMP(3) NOT NULL,
    "subtotal"        DECIMAL(12,2) NOT NULL,
    "vatAmount"       DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total"           DECIMAL(12,2) NOT NULL,
    "paidAmount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status"          "SupplierBillStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierBill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierBill_garageId_billNumber_key"
    ON "SupplierBill"("garageId", "billNumber");
CREATE INDEX "SupplierBill_garageId_status_idx"
    ON "SupplierBill"("garageId", "status");
CREATE INDEX "SupplierBill_supplierId_idx"
    ON "SupplierBill"("supplierId");
CREATE INDEX "SupplierBill_purchaseOrderId_idx"
    ON "SupplierBill"("purchaseOrderId");

ALTER TABLE "SupplierBill"
    ADD CONSTRAINT "SupplierBill_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierBill"
    ADD CONSTRAINT "SupplierBill_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierBill"
    ADD CONSTRAINT "SupplierBill_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── SupplierPayment ────────────────────────────────────────────
CREATE TABLE "SupplierPayment" (
    "id"         TEXT NOT NULL,
    "garageId"   TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount"     DECIMAL(12,2) NOT NULL,
    "method"     TEXT NOT NULL,
    "paidAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note"       TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierPayment_garageId_idx"
    ON "SupplierPayment"("garageId");
CREATE INDEX "SupplierPayment_supplierId_idx"
    ON "SupplierPayment"("supplierId");
CREATE INDEX "SupplierPayment_paidAt_idx"
    ON "SupplierPayment"("paidAt");

ALTER TABLE "SupplierPayment"
    ADD CONSTRAINT "SupplierPayment_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment"
    ADD CONSTRAINT "SupplierPayment_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── SupplierPaymentAllocation ──────────────────────────────────
CREATE TABLE "SupplierPaymentAllocation" (
    "id"                TEXT NOT NULL,
    "supplierPaymentId" TEXT NOT NULL,
    "supplierBillId"    TEXT NOT NULL,
    "amount"            DECIMAL(12,2) NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPaymentAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierPaymentAllocation_supplierPaymentId_idx"
    ON "SupplierPaymentAllocation"("supplierPaymentId");
CREATE INDEX "SupplierPaymentAllocation_supplierBillId_idx"
    ON "SupplierPaymentAllocation"("supplierBillId");

ALTER TABLE "SupplierPaymentAllocation"
    ADD CONSTRAINT "SupplierPaymentAllocation_supplierPaymentId_fkey"
    FOREIGN KEY ("supplierPaymentId") REFERENCES "SupplierPayment"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPaymentAllocation"
    ADD CONSTRAINT "SupplierPaymentAllocation_supplierBillId_fkey"
    FOREIGN KEY ("supplierBillId") REFERENCES "SupplierBill"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Delete-audit tables (triggers land in C2) ──────────────────
CREATE TABLE "SupplierBillDeleteAudit" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "supplierBillId" TEXT NOT NULL,
    "garageId"       TEXT NOT NULL,
    "supplierId"     TEXT NOT NULL,
    "billNumber"     INTEGER NOT NULL,
    "status"         TEXT NOT NULL,
    "subtotal"       DECIMAL(12,2) NOT NULL,
    "vatAmount"      DECIMAL(12,2) NOT NULL,
    "total"          DECIMAL(12,2) NOT NULL,
    "paidAmount"     DECIMAL(12,2) NOT NULL,
    "billDate"       TIMESTAMP(3) NOT NULL,
    "outcome"        TEXT NOT NULL,
    "attemptedBy"    TEXT NOT NULL,
    "note"           TEXT,
    "attemptedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierBillDeleteAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierBillDeleteAudit_garageId_idx"
    ON "SupplierBillDeleteAudit"("garageId");
CREATE INDEX "SupplierBillDeleteAudit_outcome_idx"
    ON "SupplierBillDeleteAudit"("outcome");
CREATE INDEX "SupplierBillDeleteAudit_attemptedAt_idx"
    ON "SupplierBillDeleteAudit"("attemptedAt");

CREATE TABLE "SupplierPaymentDeleteAudit" (
    "id"                TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "supplierPaymentId" TEXT NOT NULL,
    "garageId"          TEXT NOT NULL,
    "supplierId"        TEXT NOT NULL,
    "amount"            DECIMAL(12,2) NOT NULL,
    "method"            TEXT NOT NULL,
    "paidAt"            TIMESTAMP(3) NOT NULL,
    "outcome"           TEXT NOT NULL,
    "attemptedBy"       TEXT NOT NULL,
    "note"              TEXT,
    "attemptedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPaymentDeleteAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierPaymentDeleteAudit_garageId_idx"
    ON "SupplierPaymentDeleteAudit"("garageId");
CREATE INDEX "SupplierPaymentDeleteAudit_outcome_idx"
    ON "SupplierPaymentDeleteAudit"("outcome");
CREATE INDEX "SupplierPaymentDeleteAudit_attemptedAt_idx"
    ON "SupplierPaymentDeleteAudit"("attemptedAt");
