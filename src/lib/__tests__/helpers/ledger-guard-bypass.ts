/**
 * Ledger-source delete-guard bypass for tests.
 *
 * The triggers in
 *   prisma/migrations/20260819160000_ledger_source_delete_guard/migration.sql
 * refuse to delete Payment, AdvancePayment, or non-DRAFT Invoice rows
 * unless the calling session sets `app.allow_*_delete = 'true'`.
 * Test cleanup functions have a legitimate need to blow away every row
 * they seeded, including SENT invoices and their payments.
 *
 * This helper wraps arbitrary DELETE / cleanup SQL in a transaction
 * that sets all three flags, so a test's teardown can proceed without
 * fighting the guard row-by-row. Use only from `beforeAll` / `afterAll`
 * / `beforeEach` cleanup — never from production code.
 */

import type { PrismaClient } from "@/generated/prisma/client";

// Prisma's callback-transaction handle type — the client with the
// long-tail lifecycle methods stripped. Kept minimal on purpose so
// this helper isn't tied to Prisma's exported alias name.
type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/** Run `fn` inside a transaction that has all three delete-guard flags
 *  set. `fn` receives the transaction handle and can issue any Prisma
 *  calls or raw SQL against it — the guards will allow the deletes
 *  because the flags are set for the transaction's lifetime.
 *
 *  The audit-log entries written by the trigger carry
 *  note='test-cleanup' so an ops query can distinguish test noise from
 *  real operator-driven deletes. */
export async function withDeleteGuardBypass<T>(
  prisma: PrismaClient,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.allow_invoice_delete = 'true'`);
    await tx.$executeRawUnsafe(`SET LOCAL app.allow_payment_delete = 'true'`);
    await tx.$executeRawUnsafe(`SET LOCAL app.allow_advance_delete = 'true'`);
    await tx.$executeRawUnsafe(`SET LOCAL app.delete_note = 'test-cleanup'`);
    return fn(tx);
  }, { timeout: 30_000 });
}
