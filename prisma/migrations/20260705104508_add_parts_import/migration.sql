-- CreateEnum
CREATE TYPE "PartsImportStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'DISCARDED');

-- CreateTable
CREATE TABLE "PartsImport" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "supplierName" TEXT,
    "status" "PartsImportStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartsImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartsImportLine" (
    "id" TEXT NOT NULL,
    "partsImportId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "include" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartsImportLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartsImport_garageId_status_idx" ON "PartsImport"("garageId", "status");

-- CreateIndex
CREATE INDEX "PartsImportLine_partsImportId_idx" ON "PartsImportLine"("partsImportId");

-- AddForeignKey
ALTER TABLE "PartsImport" ADD CONSTRAINT "PartsImport_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartsImport" ADD CONSTRAINT "PartsImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartsImportLine" ADD CONSTRAINT "PartsImportLine_partsImportId_fkey" FOREIGN KEY ("partsImportId") REFERENCES "PartsImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
