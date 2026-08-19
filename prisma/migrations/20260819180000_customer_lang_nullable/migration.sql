-- Customer.lang null + Garage.defaultLang (AR 2026-08-19).
--
-- The old Customer.lang @default(ar) populated every prod customer
-- row with "ar" regardless of whether the customer had ever
-- indicated Arabic. Audit 2026-08-19: all 22 prod rows are "ar" and
-- none of them was a real choice — the value is fabricated. Every
-- outbound path (invoice, estimate, reminder) that trusted it
-- shipped Arabic to English / Hindi / Urdu speakers.
--
-- Following business-rules.md rule 7 (production write paths never
-- fabricate): drop the default, allow null. Null now honestly means
-- "we don't know" instead of asserting a language we made up.
--
-- Garage.defaultLang is a new shop-wide fallback for the resolver.
-- Also nullable — a shop that hasn't set one falls through to "en"
-- as last resort. This lets a garage in a Hindi-speaking area
-- (Karama, Sonapur) opt into "hi" without touching every customer
-- row, and lets one in the DIFC choose "en" for the same reason.
--
-- BACKFILL (not run by this migration — the operator triggers it
-- explicitly once the schema change lands):
--
--     UPDATE "Customer" SET lang = NULL;
--
-- Every prod row is a fabricated "ar". Clearing them to NULL means
-- the resolver falls to Garage.defaultLang or English last-resort
-- until a real language signal (an inbound message the detector
-- reads, or an operator setting one manually) arrives. The
-- immediate cost is that customers who actually ARE Arabic go
-- English on their next cold-start send — but the vast majority
-- have already had an inbound WhatsApp exchange from which
-- resolveCustomerLangForOutbound detects the true language, so
-- the miss window is the small tail of customers who received
-- something but never wrote back. Trade that for stopping the
-- "everyone gets Arabic" complaint on the majority.

ALTER TABLE "Garage" ADD COLUMN "defaultLang" "Lang";

ALTER TABLE "Customer" ALTER COLUMN "lang" DROP DEFAULT;
ALTER TABLE "Customer" ALTER COLUMN "lang" DROP NOT NULL;
