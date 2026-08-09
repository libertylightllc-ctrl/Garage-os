-- Send audit log for customer invoices, parallel to PurchaseOrderSend.
-- Adds an enum for channel (WhatsApp today; SMS or others later without
-- disturbing PO), a status enum matching PurchaseOrderSendStatus, and
-- the row model itself. Additive only — no data touched, no existing
-- column modified.

CREATE TYPE "InvoiceSendChannel" AS ENUM ('WHATSAPP', 'EMAIL');

CREATE TYPE "InvoiceSendStatus" AS ENUM ('HANDED_OFF', 'SENT', 'FAILED');

CREATE TABLE "InvoiceSend" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "channel" "InvoiceSendChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "sentByUserId" TEXT NOT NULL,
    "sentByName" TEXT,
    "status" "InvoiceSendStatus" NOT NULL,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceSend_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InvoiceSend_invoiceId_idx" ON "InvoiceSend"("invoiceId");
CREATE INDEX "InvoiceSend_garageId_idx" ON "InvoiceSend"("garageId");

ALTER TABLE "InvoiceSend"
    ADD CONSTRAINT "InvoiceSend_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceSend"
    ADD CONSTRAINT "InvoiceSend_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InvoiceSend"
    ADD CONSTRAINT "InvoiceSend_sentByUserId_fkey"
    FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
