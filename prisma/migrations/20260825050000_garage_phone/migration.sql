-- AR 2026-08-25 Batch F1 — Garage.phone as a fallback for advisor
-- snapshot on estimates + invoices. A customer meant to call back
-- needs a number; if the individual advisor's User.phone is null
-- the shop's main line at least gets on the doc.
ALTER TABLE "Garage" ADD COLUMN "phone" TEXT;
