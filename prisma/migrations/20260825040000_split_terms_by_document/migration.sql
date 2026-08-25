-- AR 2026-08-25 — split Garage.terms into estimateTerms + invoiceTerms.
--
-- The Batch D single-field shipped a seven-clause sample tuned for
-- estimates ("This estimate is valid for 7 days", "final invoice may
-- vary from this estimate"). Five of the seven read wrong on an
-- invoice; a shop shipping them at the bottom of a paid invoice
-- would embarrass themselves. Splitting by document type lets each
-- surface print wording that fits it.
--
-- Rename preserves the existing estimateTerms data — RENAME COLUMN
-- is a metadata-only operation on Postgres, atomic, no rewrite. Add
-- invoiceTerms as a new nullable column with no default. Existing
-- garages carry their old (estimate-appropriate) wording forward as
-- estimateTerms and start invoiceTerms empty; the Settings form
-- prefills a 4-clause invoice sample on first open so shops adopt
-- or edit rather than leave blank.

ALTER TABLE "Garage" RENAME COLUMN "terms" TO "estimateTerms";
ALTER TABLE "Garage" ADD COLUMN "invoiceTerms" TEXT;
