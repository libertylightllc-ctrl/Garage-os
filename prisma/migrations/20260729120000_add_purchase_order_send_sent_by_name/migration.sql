-- Add sentByName snapshot to PurchaseOrderSend.
--
-- Companion of `recipient` and `documentKind`: the sender's display name
-- at send time, frozen so a later User rename or offboarding cannot
-- retroactively rewrite who sent the document. Reader prefers this
-- snapshot; falls back to the User join only when null. No pre-migration
-- rows can exist (nothing has ever written to PurchaseOrderSend yet —
-- this ships with the first writer), so the nullable column is trivially
-- safe on prod. The fallback is defensive-honest, not compensating for
-- real data.

ALTER TABLE "PurchaseOrderSend"
  ADD COLUMN "sentByName" TEXT;
