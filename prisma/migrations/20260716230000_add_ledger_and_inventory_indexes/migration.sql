-- Two additive indexes for the owner-side pagination slice.
--
-- Part(garageId, name)     — owner inventory table sorts by name within
--                            a garage. Without this, every open scans
--                            the whole shop's parts.
-- AdvancePayment(receivedAt) — owner ledger UNION with Payment sorts by
--                              receivedAt DESC across the shop. Mirrors
--                              Payment(paidAt) added in the earlier
--                              cashier-payments slice.
--
-- Both `CREATE INDEX CONCURRENTLY IF NOT EXISTS` so a fresh clone runs
-- clean and a manual-first psql (path B in the earlier deploy) turns
-- into a no-op instead of an error. Same disable-transaction marker as
-- 20260716120000_add_payment_paidat_index.

-- prisma+migrationDeploy: disable-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Part_garageId_name_idx"
  ON "Part"("garageId", "name");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdvancePayment_receivedAt_idx"
  ON "AdvancePayment"("receivedAt");
