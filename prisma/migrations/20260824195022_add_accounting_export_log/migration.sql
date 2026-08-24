-- AR 2026-08-23. Standalone additive audit log — no FK into any
-- existing model. See prisma/schema.prisma model AccountingExportLog.
-- Written by src/app/api/accounting/export/route.ts on every download.
CREATE TABLE "AccountingExportLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userRole" TEXT NOT NULL,
    "ownerGarageId" TEXT NOT NULL,
    "scopeGarageIds" TEXT NOT NULL,
    "rangeFromIso" TEXT NOT NULL,
    "rangeToIso" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingExportLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountingExportLog_createdAt_idx" ON "AccountingExportLog"("createdAt");

CREATE INDEX "AccountingExportLog_ownerGarageId_createdAt_idx" ON "AccountingExportLog"("ownerGarageId", "createdAt");
