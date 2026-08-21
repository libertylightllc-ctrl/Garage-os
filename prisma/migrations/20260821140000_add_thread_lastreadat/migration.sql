-- WhatsAppThread.lastReadAt — advisor's last-viewed timestamp for
-- the thread. The chat inbox reads it to count unread inbound
-- messages (createdAt > lastReadAt) and render a pill. Stamped by
-- the /advisor/chats/[id] page on every open.
--
-- Nullable, no default. Existing threads read as "never opened" →
-- every past inbound message counts as unread on first render.
-- Advisor's next visit stamps it, and only new inbound messages
-- count from then on. No backfill needed.
--
-- AR 2026-08-21 (Batch 2 — visibility).

ALTER TABLE "WhatsAppThread" ADD COLUMN "lastReadAt" TIMESTAMP(3);
