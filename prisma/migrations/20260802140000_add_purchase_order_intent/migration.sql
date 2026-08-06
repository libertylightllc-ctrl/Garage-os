-- Author's INTENT on the purchase-order document at creation time.
-- Distinguishes "asked a supplier to quote" (QUOTE) from "placing an
-- order at known prices" (ORDER). Layer-0/1 landed the two-mode entry
-- via ?mode= on the URL and a hidden form field, but the mode was
-- never persisted — a reload of a DRAFT+ORDER doc reverted to the
-- status-based classifier and read as "Request for Quotation" on the
-- title. This column stores the intent so poDocKind can prefer it
-- while status is DRAFT.
--
-- Backfill: default 'QUOTE' fills every existing row (all current
-- DRAFTs were created before this field existed and behaved as
-- quotations; post-DRAFT rows would read as PO from the status-based
-- classifier regardless, so the intent value on those is inert).
-- Nothing needs a data-driven backfill.
--
-- Enum → additive, safe rollback: DROP COLUMN + DROP TYPE.

CREATE TYPE "PurchaseOrderIntent" AS ENUM ('QUOTE', 'ORDER');

ALTER TABLE "PurchaseOrder"
  ADD COLUMN "intent" "PurchaseOrderIntent" NOT NULL DEFAULT 'QUOTE';
