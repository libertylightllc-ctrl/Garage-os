-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADVISOR', 'TECH', 'ACCOUNTANT');

-- CreateEnum
CREATE TYPE "Lang" AS ENUM ('ar', 'en');

-- CreateEnum
CREATE TYPE "BookingChannel" AS ENUM ('WA', 'WEB', 'PHONE');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "HoldReason" AS ENUM ('AWAITING_PART', 'AWAITING_CUSTOMER', 'OTHER');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('ARRIVED', 'INSPECTION', 'ESTIMATE', 'APPROVED', 'REPAIR', 'INVOICED', 'DELIVERED', 'ON_HOLD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'SENT', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "ClearanceStatus" AS ENUM ('NA', 'PENDING', 'CLEARED');

-- CreateEnum
CREATE TYPE "LineKind" AS ENUM ('LABOR', 'PART', 'FEE');

-- CreateEnum
CREATE TYPE "WaConnStatus" AS ENUM ('CONNECTED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "WaMode" AS ENUM ('BOT', 'HUMAN');

-- CreateEnum
CREATE TYPE "WaThreadStatus" AS ENUM ('OPEN', 'NEEDS_HUMAN', 'CLOSED');

-- CreateEnum
CREATE TYPE "WaMsgState" AS ENUM ('RECEIVED', 'SENT', 'PENDING_APPROVAL', 'DRAFT');

-- CreateEnum
CREATE TYPE "WaDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "AiKind" AS ENUM ('INTAKE', 'COPILOT', 'OCR', 'RECEPTIONIST');

-- CreateEnum
CREATE TYPE "SubStatus" AS ENUM ('PILOT', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateTable
CREATE TABLE "Garage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'UAE',
    "trn" TEXT,
    "branchOfId" TEXT,
    "settingsJson" JSONB,
    "invoiceSeq" INTEGER NOT NULL DEFAULT 0,
    "isPilot" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Garage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMonthly" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "stripePriceId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "planId" TEXT,
    "status" "SubStatus" NOT NULL DEFAULT 'PILOT',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "trialEnd" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "lang" "Lang" NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "lang" "Lang" NOT NULL DEFAULT 'ar',
    "trn" TEXT,
    "waId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER,
    "plate" TEXT NOT NULL,
    "vin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "channel" "BookingChannel" NOT NULL,
    "rawText" TEXT,
    "voiceNoteUrl" TEXT,
    "photoUrls" TEXT[],
    "aiProposalJson" JSONB,
    "status" "BookingStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCard" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "advisorId" TEXT,
    "bookingId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'ARRIVED',
    "heldFrom" "JobStatus",
    "holdReason" "HoldReason",
    "holdNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStep" (
    "id" TEXT NOT NULL,
    "jobCardId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "photoUrl" TEXT,
    "voiceNoteUrl" TEXT,
    "transcript" TEXT,
    "techId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" TEXT NOT NULL,
    "jobCardId" TEXT NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "vatAmount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateLine" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "kind" "LineKind" NOT NULL,
    "partId" TEXT,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "vatRate" DECIMAL(5,4) NOT NULL DEFAULT 0.05,
    "declined" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EstimateLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "jobCardId" TEXT NOT NULL,
    "estimateId" TEXT,
    "number" INTEGER NOT NULL,
    "customerTrn" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "vatAmount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "qrPayload" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "clearanceStatus" "ClearanceStatus" NOT NULL DEFAULT 'NA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "LineKind" NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "vatRate" DECIMAL(5,4) NOT NULL DEFAULT 0.05,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Part" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qtyOnHand" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(12,2) NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartMovement" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "jobCardId" TEXT,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "debit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "wabaId" TEXT,
    "phoneNumberId" TEXT,
    "phoneNumber" TEXT,
    "accessTokenEnc" TEXT,
    "status" "WaConnStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppThread" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "waId" TEXT NOT NULL,
    "mode" "WaMode" NOT NULL DEFAULT 'BOT',
    "threadStatus" "WaThreadStatus" NOT NULL DEFAULT 'OPEN',
    "assignedAdvisorId" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "direction" "WaDirection" NOT NULL,
    "template" TEXT,
    "body" TEXT,
    "waMessageId" TEXT NOT NULL,
    "status" TEXT,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "state" "WaMsgState" NOT NULL DEFAULT 'SENT',
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiEvent" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" "AiKind" NOT NULL,
    "model" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "tokensIn" INTEGER NOT NULL,
    "tokensOut" INTEGER NOT NULL,
    "costEstimate" DECIMAL(12,6) NOT NULL,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_garageId_key" ON "Subscription"("garageId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_stripeEventId_key" ON "BillingEvent"("stripeEventId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_garageId_idx" ON "User"("garageId");

-- CreateIndex
CREATE INDEX "Customer_garageId_idx" ON "Customer"("garageId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_garageId_phone_key" ON "Customer"("garageId", "phone");

-- CreateIndex
CREATE INDEX "Vehicle_customerId_idx" ON "Vehicle"("customerId");

-- CreateIndex
CREATE INDEX "Booking_garageId_status_idx" ON "Booking"("garageId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JobCard_bookingId_key" ON "JobCard"("bookingId");

-- CreateIndex
CREATE INDEX "JobCard_garageId_status_idx" ON "JobCard"("garageId", "status");

-- CreateIndex
CREATE INDEX "JobStep_jobCardId_idx" ON "JobStep"("jobCardId");

-- CreateIndex
CREATE INDEX "Estimate_jobCardId_idx" ON "Estimate"("jobCardId");

-- CreateIndex
CREATE INDEX "EstimateLine_estimateId_idx" ON "EstimateLine"("estimateId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_estimateId_key" ON "Invoice"("estimateId");

-- CreateIndex
CREATE INDEX "Invoice_garageId_status_idx" ON "Invoice"("garageId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_garageId_number_key" ON "Invoice"("garageId", "number");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Part_garageId_sku_key" ON "Part"("garageId", "sku");

-- CreateIndex
CREATE INDEX "PartMovement_partId_idx" ON "PartMovement"("partId");

-- CreateIndex
CREATE INDEX "LedgerEntry_garageId_account_idx" ON "LedgerEntry"("garageId", "account");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_garageId_key" ON "WhatsAppAccount"("garageId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_phoneNumberId_key" ON "WhatsAppAccount"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppThread_garageId_waId_key" ON "WhatsAppThread"("garageId", "waId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppMessage_waMessageId_key" ON "WhatsAppMessage"("waMessageId");

-- CreateIndex
CREATE INDEX "WhatsAppMessage_threadId_idx" ON "WhatsAppMessage"("threadId");

-- CreateIndex
CREATE INDEX "AiEvent_garageId_kind_idx" ON "AiEvent"("garageId", "kind");

-- AddForeignKey
ALTER TABLE "Garage" ADD CONSTRAINT "Garage_branchOfId_fkey" FOREIGN KEY ("branchOfId") REFERENCES "Garage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_advisorId_fkey" FOREIGN KEY ("advisorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStep" ADD CONSTRAINT "JobStep_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStep" ADD CONSTRAINT "JobStep_techId_fkey" FOREIGN KEY ("techId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateLine" ADD CONSTRAINT "EstimateLine_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateLine" ADD CONSTRAINT "EstimateLine_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartMovement" ADD CONSTRAINT "PartMovement_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartMovement" ADD CONSTRAINT "PartMovement_jobCardId_fkey" FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppThread" ADD CONSTRAINT "WhatsAppThread_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppThread" ADD CONSTRAINT "WhatsAppThread_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "WhatsAppThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiEvent" ADD CONSTRAINT "AiEvent_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiEvent" ADD CONSTRAINT "AiEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
