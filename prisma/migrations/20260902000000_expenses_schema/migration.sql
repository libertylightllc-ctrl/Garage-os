-- AR 2026-09-02 — Accounting phase, E1a (schema commit).
--
-- Money spent that isn't parts. Direct-posting per AR's Q3:
-- DR <expense account> / CR Cash on record. No AP intermediary,
-- no accrual step. Every Expense row writes one balanced ledger
-- pair, keyed sourceType='EXPENSE' (single source type per AR's
-- Q2 — category on the row). MVP posts gross (no VAT split);
-- VAT-input on expenses lands in a separate follow-up before E4.
--
-- Additive only. No existing table changed.

CREATE TYPE "ExpenseCategory" AS ENUM (
    'RENT',
    'SALARIES',
    'UTILITIES',
    'TOOLS',
    'VEHICLE',
    'MARKETING',
    'BANK_CHARGES',
    'OFFICE',
    'REPAIRS_MAINT',
    'PROF_FEES',
    'MISC'
);

CREATE TYPE "ExpenseStatus" AS ENUM (
    'ACTIVE',
    'VOID'
);

CREATE TABLE "Expense" (
    "id"            TEXT NOT NULL,
    "garageId"      TEXT NOT NULL,
    "category"      "ExpenseCategory" NOT NULL,
    "amount"        DECIMAL(12,2) NOT NULL,
    "paidAt"        TIMESTAMP(3) NOT NULL,
    "method"        TEXT NOT NULL,
    "supplierId"    TEXT,
    "note"          TEXT,
    "attachmentUrl" TEXT,
    "status"        "ExpenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Expense_garageId_paidAt_idx"
    ON "Expense"("garageId", "paidAt");
CREATE INDEX "Expense_garageId_status_idx"
    ON "Expense"("garageId", "status");
CREATE INDEX "Expense_supplierId_idx"
    ON "Expense"("supplierId");

ALTER TABLE "Expense"
    ADD CONSTRAINT "Expense_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense"
    ADD CONSTRAINT "Expense_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Delete-audit table (trigger lands in E1b).
CREATE TABLE "ExpenseDeleteAudit" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "expenseId"   TEXT NOT NULL,
    "garageId"    TEXT NOT NULL,
    "category"    TEXT NOT NULL,
    "amount"      DECIMAL(12,2) NOT NULL,
    "paidAt"      TIMESTAMP(3) NOT NULL,
    "method"      TEXT NOT NULL,
    "status"      TEXT NOT NULL,
    "outcome"     TEXT NOT NULL,
    "attemptedBy" TEXT NOT NULL,
    "note"        TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseDeleteAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExpenseDeleteAudit_garageId_idx"
    ON "ExpenseDeleteAudit"("garageId");
CREATE INDEX "ExpenseDeleteAudit_outcome_idx"
    ON "ExpenseDeleteAudit"("outcome");
CREATE INDEX "ExpenseDeleteAudit_attemptedAt_idx"
    ON "ExpenseDeleteAudit"("attemptedAt");
