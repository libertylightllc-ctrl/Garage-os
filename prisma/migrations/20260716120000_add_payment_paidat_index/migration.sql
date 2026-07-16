-- Cashier Payments tab pagination sorts by MAX(paidAt) DESC across all
-- payments in the shop. Index on Payment(paidAt) so the ORDER BY on the
-- pagination raw SQL runs on an index scan rather than a heap scan.
-- Zero data change — additive index.

-- Prisma's default is to wrap each migration in a transaction. Postgres
-- forbids CREATE INDEX CONCURRENTLY inside a transaction, so this file
-- opts out with the marker below. Prisma 5+ honours it.

-- prisma+migrationDeploy: disable-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Payment_paidAt_idx" ON "Payment"("paidAt");
