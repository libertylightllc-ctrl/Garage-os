-- Split the "sent" concept into two timestamps on JobCard:
--
--   invoiceSentAt      — HANDED OFF (existing column, wa.me redirect
--                        fires, operator's WhatsApp opens with the
--                        message pre-filled). Stays as-is.
--   invoiceDeliveredAt — CUSTOMER RECEIVED (new column). Set only
--                        when we can observe delivery, i.e., when
--                        the Meta Cloud API webhook fires the
--                        `delivered` event. Null under wa.me.
--
-- Additive only, nullable, no backfill (both fields will be null on
-- pre-migration rows; those rows are DRAFT invoices anyway, and any
-- delivered invoices predating this commit ARE already treated as
-- delivered by the old code's invoiceSentAt-keyed lock — the new
-- lock (invoiceDeliveredAt-keyed) will let those be re-opened by
-- an operator. That's the intended behaviour under the new model:
-- if we don't know it was delivered, don't act like it was.

ALTER TABLE "JobCard"
    ADD COLUMN "invoiceDeliveredAt" TIMESTAMP(3);
