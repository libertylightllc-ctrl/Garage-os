-- Batch B — Garage.address + Garage.vatRate (AR 2026-08-19).
--
-- address:
--   Free-text field printed on the DocumentHeader of every tax
--   invoice and estimate. UAE FTA Article 59 requires the
--   supplier's name + TRN + address on every tax invoice, so
--   shipping any UAE shop without a way to fill this in is a
--   compliance gap. Nullable so existing shops (which have no
--   value today) still resolve; the Settings UI marks it as
--   recommended and the DocumentHeader hides the line when null
--   rather than printing "—". 400-char cap so a full UAE address
--   fits (P.O. Box + building + landmark + street + area + city).
--
-- vatRate:
--   Per-garage VAT rate, 4-dp decimal (0.05 = 5 %). Added now
--   with the UAE default so Phase 2 (multi-country: KSA 15 %,
--   Kuwait, etc.) doesn't need another migration once tables
--   carry live invoice history. Read-only in the Settings UI in
--   Batch B — UAE VAT is a legal constant, not a shop
--   preference — but the storage exists so a later multi-country
--   VAT strategy switches on cleanly. `totalsFor` and the current
--   UAEStrategy still read the module constant `UAE_VAT_RATE`
--   from src/lib/vat.ts until the strategy plumbing changes.
--
-- Zero backfill needed: address defaults to NULL, vatRate defaults
-- to 0.05 for every existing row via the column default.

ALTER TABLE "Garage" ADD COLUMN "address" TEXT;
ALTER TABLE "Garage" ADD COLUMN "vatRate" DECIMAL(5,4) DEFAULT 0.05;
