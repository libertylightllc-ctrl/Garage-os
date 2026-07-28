-- PurchaseOrderSend — audit log for send attempts on a PO.
-- One row per WhatsApp click or Email send. Nullable-safe: no existing
-- data references this table, no backfill needed. Readers land in a
-- follow-up commit; this migration only adds the schema.
--
-- Intentional omissions (see model comment in prisma/schema.prisma):
--   • no PRINT channel (local, no recipient, no observable outcome)
--   • no DELIVERED status (needs a Resend webhook, ships with the webhook)
--
-- recipient + documentKind are SNAPSHOTS at send time — history must
-- still show what actually went out even if the supplier's email
-- changes or the PO is edited from RFQ into a priced PO afterwards.

CREATE TYPE "PurchaseOrderSendChannel" AS ENUM ('WHATSAPP', 'EMAIL');
CREATE TYPE "PurchaseOrderSendStatus"  AS ENUM ('HANDED_OFF', 'SENT', 'FAILED');
CREATE TYPE "PurchaseOrderDocumentKind" AS ENUM ('PO', 'RFQ');

CREATE TABLE "PurchaseOrderSend" (
  "id"                TEXT                        NOT NULL,
  "purchaseOrderId"   TEXT                        NOT NULL,
  "garageId"          TEXT                        NOT NULL,
  "channel"           "PurchaseOrderSendChannel"  NOT NULL,
  "recipient"         TEXT                        NOT NULL,
  "documentKind"      "PurchaseOrderDocumentKind" NOT NULL,
  "sentByUserId"      TEXT                        NOT NULL,
  "status"            "PurchaseOrderSendStatus"   NOT NULL,
  "providerMessageId" TEXT,
  "errorCode"         TEXT,
  "createdAt"         TIMESTAMP(3)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseOrderSend_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PurchaseOrderSend"
  ADD CONSTRAINT "PurchaseOrderSend_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderSend"
  ADD CONSTRAINT "PurchaseOrderSend_garageId_fkey"
  FOREIGN KEY ("garageId") REFERENCES "Garage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderSend"
  ADD CONSTRAINT "PurchaseOrderSend_sentByUserId_fkey"
  FOREIGN KEY ("sentByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "PurchaseOrderSend_purchaseOrderId_idx"
  ON "PurchaseOrderSend"("purchaseOrderId");

CREATE INDEX "PurchaseOrderSend_garageId_idx"
  ON "PurchaseOrderSend"("garageId");
