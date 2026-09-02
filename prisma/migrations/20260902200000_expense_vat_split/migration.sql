-- AR 2026-09-02 — E1f, VAT split on Expense (rule 12 build trigger).
--
-- Splits the single `amount` column into three:
--   total     — what cash actually left the shop (verbatim rename from amount)
--   subtotal  — total minus reclaimable VAT
--   vatAmount — reclaimable input VAT the operator explicitly entered
--
-- Cutover discipline (matches rule 10 for COGS): existing rows are
-- treated as gross with zero VAT. Back-calcing 5/105 across pre-E1f
-- rows would fabricate reclaim data the operator never asserted.
-- Only 1 physical Expense row exists on Prod today (Demo RENT, VOID);
-- the discipline matters for the code that reads back, not the row
-- count.
--
-- Ledger writer + form UI ship in the same commit as this migration.

-- Add the two new columns as nullable so we can backfill before
-- flipping them NOT NULL. Same shape Payables C3 used for its
-- supplier-bill columns.
ALTER TABLE "Expense"
    ADD COLUMN "subtotal"  DECIMAL(12,2),
    ADD COLUMN "vatAmount" DECIMAL(12,2);

-- Backfill: pre-E1f rows treated as gross-with-no-VAT.
UPDATE "Expense" SET "subtotal" = "amount", "vatAmount" = 0;

-- Rename the existing gross column to its correct name.
ALTER TABLE "Expense" RENAME COLUMN "amount" TO "total";

-- Now flip the new columns to NOT NULL — every row has a value.
ALTER TABLE "Expense"
    ALTER COLUMN "subtotal"  SET NOT NULL,
    ALTER COLUMN "vatAmount" SET NOT NULL;
