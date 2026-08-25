-- AR 2026-08-25 — Invoice ↔ Estimate parity, additive-only.
-- Adds four snapshot-at-generation columns to Invoice so the
-- customer-facing invoice can carry the same four blocks the
-- estimate already does (remarks, payment terms, service advisor).
-- Terms & conditions block reads Garage.terms (Batch D) — no
-- per-invoice column for that.
--
-- All four nullable; no default; existing invoices render each
-- block as null (block simply doesn't render) — honest, no backfill.

ALTER TABLE "Invoice" ADD COLUMN "remarks" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "paymentTerms" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "advisorNameSnapshot" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "advisorPhoneSnapshot" TEXT;
