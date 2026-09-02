-- AR 2026-09-03 — E4b, Form 201 emirate capture.
--
-- Adds the Emirate enum + Garage.emirate + Invoice.emirate. Both
-- fields are nullable during rollout so operator time to open
-- /settings doesn't block the deploy or corrupt in-flight invoices.
--
-- Invoice.emirate is a SNAPSHOT captured by generateInvoiceAction
-- inside the same tx that creates the invoice — same discipline as
-- InvoiceLine.unitCost / advisorNameSnapshot. Prior-quarter Form 201
-- must never change, so a garage that moves emirates must not
-- rewrite its historical rows.
--
-- Values match FTA canonical spelling on tax.gov.ae. Don't rename
-- without also touching the eventual FTA export pipeline.
--
-- Backfill: Invoice.emirate inherits the garage's current emirate
-- (which may be null — the coverage banner on the VAT summary
-- calls that out; operator either sets Garage.emirate + re-runs
-- this backfill script, or accepts an "unassigned" box on Form 201).
-- Pre-cutover invoices carry an INFERRED emirate — noted in rule 14
-- so an auditor reading the export knows they weren't captured at
-- generation time.

CREATE TYPE "Emirate" AS ENUM (
    'AbuDhabi',
    'Dubai',
    'Sharjah',
    'Ajman',
    'UmmAlQuwain',
    'RasAlKhaimah',
    'Fujairah'
);

ALTER TABLE "Garage"  ADD COLUMN "emirate" "Emirate";
ALTER TABLE "Invoice" ADD COLUMN "emirate" "Emirate";

-- Backfill from the garage. Null-safe: any garage whose emirate is
-- unset leaves its invoices' emirate null too, which the VAT summary
-- surfaces as an "unassigned" bucket instead of guessing.
UPDATE "Invoice" i
SET "emirate" = g."emirate"
FROM "Garage" g
WHERE i."garageId" = g."id"
  AND i."emirate" IS NULL
  AND g."emirate" IS NOT NULL;
