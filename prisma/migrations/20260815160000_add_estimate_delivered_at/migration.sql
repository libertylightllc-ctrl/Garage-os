-- Estimate delivery timestamp (AR 2026-08-15, estimate-honesty pass).
-- Nullable — populated by the WhatsApp Cloud API webhook when a
-- delivered event lands. In the wa.me era (current) stays NULL
-- forever; the operator's local WhatsApp doesn't report back.
-- Mirror of JobCard.invoiceDeliveredAt so estimate + invoice
-- surfaces read the same lifecycle. See schema comment on
-- Estimate.deliveredAt for the rule.
ALTER TABLE "Estimate"
  ADD COLUMN "deliveredAt" TIMESTAMP(3);
