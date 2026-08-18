-- AR 2026-08-19 — mark WhatsApp messages that were fabricated by the
-- deleted test tools (startTestConversationAction,
-- simulateInboundAction) so an audit reader can distinguish real
-- customer speech from staff-injected fake speech.
--
-- Same commit deletes the two tools + their UI. This migration
-- (1) adds the column with default false so all future writes are
-- non-simulated by default, and (2) backfills existing sim-*
-- rows to true so the historical damage is visibly marked.
--
-- Per AR's probe run on 2026-08-19: 4 rows in prod match. The
-- backfill is idempotent — re-running does nothing beyond the
-- first pass because the WHERE only touches unmarked rows.

ALTER TABLE "WhatsAppMessage"
  ADD COLUMN "simulated" BOOLEAN NOT NULL DEFAULT false;

-- Backfill. The sim- prefix on waMessageId was the sole marker the
-- deleted actions produced (see the historical
-- startTestConversationAction / simulateInboundAction — both used
-- `sim-${randomUUID()}` as the message id). No real customer
-- message can start with sim- because Meta's Cloud API ids are
-- prefixed differently (typically wamid.* base64).
UPDATE "WhatsAppMessage"
   SET "simulated" = true
 WHERE "waMessageId" LIKE 'sim-%';
