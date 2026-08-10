-- Per-document customer/supplier link tokens (Phase 1, 2026-08-10).
--
-- Adds a nullable `publicToken` column + unique index to each of the
-- four models whose customer-facing URLs today embed an HMAC-signed
-- token derived from AUTH_SECRET (@/lib/tokens.signId):
--   - Invoice        (/c/invoice/<publicToken>)
--   - Estimate       (/c/estimate/<publicToken>)
--   - PurchaseOrder  (/c/po/<publicToken>)
--   - JobCard        (/c/delivery/<publicToken>)
--
-- Phase 1 is passive: this migration only adds the column shape. The
-- application still signs URLs with the HMAC scheme. A separate
-- backfill script (scripts/backfill-public-tokens.ts) populates
-- existing rows with a 32-char URL-safe random token after this
-- migration deploys.
--
-- Phase 2 (later commit): write path fills publicToken at row create
-- time, and the sender actions (send-invoice-to-customer, etc.) emit
-- URLs with the raw token as the segment. verifyToken accepts both
-- shapes (HMAC-signed + plain token) during a grace window.
--
-- Phase 3 (~90d later): remove HMAC path entirely; AUTH_SECRET is no
-- longer involved in customer-link validity.
--
-- Motivation: the 2026-08-01 Vercel AUTH_SECRET rotation orphaned 42
-- estimate links + made the INV-2026-0039 signature failure possible.
-- Decoupling customer-link validity from a shared, rotatable secret
-- closes that class permanently.

ALTER TABLE "Invoice"       ADD COLUMN "publicToken" TEXT;
ALTER TABLE "Estimate"      ADD COLUMN "publicToken" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "publicToken" TEXT;
ALTER TABLE "JobCard"       ADD COLUMN "publicToken" TEXT;

CREATE UNIQUE INDEX "Invoice_publicToken_key"       ON "Invoice"       ("publicToken");
CREATE UNIQUE INDEX "Estimate_publicToken_key"      ON "Estimate"      ("publicToken");
CREATE UNIQUE INDEX "PurchaseOrder_publicToken_key" ON "PurchaseOrder" ("publicToken");
CREATE UNIQUE INDEX "JobCard_publicToken_key"       ON "JobCard"       ("publicToken");
