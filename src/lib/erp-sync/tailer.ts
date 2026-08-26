// ERPNext sync — ledger tailer (Phase 2 of ERPNEXT_SYNC_BRIEF.md).
//
// Reads LedgerEntry rows in (createdAt, id) order per garage, converts
// each unique (sourceType, sourceId) into an ErpSyncJob, and advances
// the cursor. NO HTTP calls. NO writes to ERPNext. That is Phase 3.
//
// Constraint 3 of the brief: this module is additive by construction.
// It never touches the ledger writers or their tables — only reads
// LedgerEntry and writes ErpSync* rows.
//
// Two load-bearing safety properties from Phase 1:
//   1. (garageId, op, sourceId) is unique on ErpSyncJob — the tailer's
//      cursor overlap on retry cannot double-enqueue. We use `upsert`
//      with an empty `update` block: a re-seen source is a no-op.
//   2. Cursor advance is in the SAME $transaction as job inserts.
//      Crash between the two: next pass re-reads the window, unique
//      constraint dedups, no event is lost. Cursor bump alone without
//      inserts is impossible.

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ErpSyncOp } from "@/generated/prisma/enums";
import { prisma as defaultPrisma } from "@/lib/prisma";

const BATCH_SIZE = 500;

/**
 * LedgerEntry.sourceType → ErpSyncJob.op mapping. All five source
 * types that ledger writers currently produce are listed EXPLICITLY —
 * `null` means "deliberately skipped, do not enqueue" and is the
 * only shape a future reader should trust for exclusion. A missing
 * key is a schema-drift signal (the writer emitted a source type we
 * don't recognise) and throws loudly.
 *
 * Why ADVANCE_MIGRATION is null: the underlying AdvancePayment was
 * already synced to ERPNext as a Payment Entry (via PUSH_ADVANCE).
 * Migrating an AdvancePayment into a Payment on the GarageOS side
 * happens inside generateInvoiceAction and is a schema-shape
 * convenience — it flips the row from `AdvancePayment` to `Payment`
 * so subsequent AR accounting matches the invoice. ERPNext handles
 * the same shape by `allocate_advances_automatically = 1` on the
 * pushed Sales Invoice (§5b of the brief), which pulls the original
 * Payment Entry against the invoice on save. Enqueuing anything
 * against ADVANCE_MIGRATION would either duplicate the deposit
 * (bad) or trigger a redundant ERPNext write (harmless but wasteful).
 * Explicit skip, named here so someone reading in six months sees
 * the reason next to the exclusion.
 */
const OP_BY_LEDGER_SOURCE: Record<string, ErpSyncOp | null> = {
    INVOICE: "PUSH_INVOICE",
    PAYMENT: "PUSH_PAYMENT",
    ADVANCE: "PUSH_ADVANCE",
    INVOICE_VOID: "PUSH_VOID",
    ADVANCE_MIGRATION: null,
};

/**
 * The WHERE-clause set: only source types we route. ADVANCE_MIGRATION
 * is not queried at all — no reason to load rows we'd immediately
 * filter out.
 */
const TAILED_SOURCE_TYPES = Object.entries(OP_BY_LEDGER_SOURCE)
    .filter(([, op]) => op !== null)
    .map(([st]) => st);

/**
 * Sentinel type for `runTailer`'s return.
 * - `advanced`: rows were seen and the cursor moved forward.
 * - `quiet`: cursor exists, no new ledger rows in this pass.
 * - `skipped-missing-cursor`: erpSyncEnabled is true but no
 *   ErpSyncCursor row exists for this garage. Almost always means
 *   someone flipped the flag directly in the DB rather than via
 *   `enableErpSyncForGarage`; the cron summary reports the id so
 *   ops sees why sync is not producing rows.
 */
export type TailerResult =
    | { garageId: string; status: "advanced"; scanned: number; enqueued: number; cursor: { lastLedgerCreatedAt: Date; lastLedgerId: string } }
    | { garageId: string; status: "quiet"; scanned: 0; enqueued: 0 }
    | { garageId: string; status: "skipped-missing-cursor"; scanned: 0; enqueued: 0 };

export async function runTailer(
    garageId: string,
    client: PrismaClient = defaultPrisma,
): Promise<TailerResult> {
    const cursor = await client.erpSyncCursor.findUnique({
        where: { garageId },
    });
    if (!cursor) {
        return { garageId, status: "skipped-missing-cursor", scanned: 0, enqueued: 0 };
    }

    // Compound cursor: (createdAt, id) STRICTLY greater than
    // (cursor.lastLedgerCreatedAt, cursor.lastLedgerId). Same-ms
    // inserts are ordered by cuid tiebreaker so no row is missed
    // or double-counted.
    const rows = await client.ledgerEntry.findMany({
        where: {
            garageId,
            sourceType: { in: TAILED_SOURCE_TYPES },
            OR: [
                { createdAt: { gt: cursor.lastLedgerCreatedAt } },
                {
                    AND: [
                        { createdAt: cursor.lastLedgerCreatedAt },
                        { id: { gt: cursor.lastLedgerId } },
                    ],
                },
            ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: BATCH_SIZE,
        select: { id: true, createdAt: true, sourceType: true, sourceId: true },
    });

    if (rows.length === 0) {
        return { garageId, status: "quiet", scanned: 0, enqueued: 0 };
    }

    // A single source doc typically writes 2–3 ledger rows in one
    // $transaction (AR/Sales/VAT for an invoice, DR/CR for a
    // payment). Group by (sourceType, sourceId) so we enqueue ONE
    // job per source doc, not one per ledger row. Insertion order
    // of a JS Map is stable and mirrors the ledger's createdAt
    // ordering — so INVOICE lands before PAYMENT / VOID for the
    // same invoice, satisfying dependency resolution in
    // `resolveDeps`.
    const uniqueSources = new Map<string, { sourceType: string; sourceId: string }>();
    for (const r of rows) {
        uniqueSources.set(`${r.sourceType}:${r.sourceId}`, {
            sourceType: r.sourceType,
            sourceId: r.sourceId,
        });
    }

    const lastRow = rows[rows.length - 1];
    let enqueued = 0;

    await client.$transaction(async (tx: Prisma.TransactionClient) => {
        for (const { sourceType, sourceId } of uniqueSources.values()) {
            const op = OP_BY_LEDGER_SOURCE[sourceType];
            if (op === null) continue; // ADVANCE_MIGRATION explicit skip
            if (op === undefined) {
                // Schema drift: a new sourceType has been added to a
                // ledger writer without updating this map. Fail loudly.
                throw new Error(
                    `[erp-tailer] unmapped LedgerEntry.sourceType "${sourceType}" — add to OP_BY_LEDGER_SOURCE`,
                );
            }

            const dependsOnJobIds = await resolveDeps({
                garageId,
                op,
                sourceType,
                sourceId,
                tx,
            });

            // Upsert with empty update: seen a second time on cursor
            // overlap, the row is left alone.
            await tx.erpSyncJob.upsert({
                where: {
                    garageId_op_sourceId: { garageId, op, sourceId },
                },
                create: {
                    garageId,
                    op,
                    sourceType: sourceTypeForJob(sourceType),
                    sourceId,
                    dependsOnJobIds,
                },
                update: {},
            });
            enqueued += 1;
        }

        // Cursor advance last, still inside the same tx. A crash
        // between job upserts and this UPDATE means the next pass
        // re-reads the window and the unique constraint dedups.
        await tx.erpSyncCursor.update({
            where: { garageId },
            data: {
                lastLedgerCreatedAt: lastRow.createdAt,
                lastLedgerId: lastRow.id,
            },
        });
    });

    return {
        garageId,
        status: "advanced",
        scanned: rows.length,
        enqueued,
        cursor: {
            lastLedgerCreatedAt: lastRow.createdAt,
            lastLedgerId: lastRow.id,
        },
    };
}

/**
 * The ErpSyncJob row records the underlying GarageOS-side doctype,
 * not the ledger source-type wire value. Phase 3's client fetches
 * the source doc by this name.
 */
function sourceTypeForJob(ledgerSourceType: string): string {
    switch (ledgerSourceType) {
        case "INVOICE":
        case "INVOICE_VOID":
            return "Invoice";
        case "PAYMENT":
            return "Payment";
        case "ADVANCE":
            return "AdvancePayment";
        default:
            throw new Error(`[erp-tailer] no jobSourceType for ${ledgerSourceType}`);
    }
}

/**
 * Direct dependencies for a source doc. Phase 3's runner refuses
 * to pick up a job whose dependsOnJobIds contains anything not yet
 * SYNCED (§7 of the brief, "Ordering"). We only declare DIRECT
 * deps — transitive ones (Payment → Invoice → Customer) are
 * enforced by the runner's SYNCED-check on every listed dep.
 *
 * INVOICE   → PUSH_CUSTOMER for the invoice's customer
 * PAYMENT   → PUSH_INVOICE for the invoice being paid
 * ADVANCE   → PUSH_CUSTOMER for the advance's customer
 * INVOICE_VOID → PUSH_INVOICE for the same invoice (can't credit-
 *               note a document that doesn't exist in ERPNext)
 *
 * On PAYMENT / INVOICE_VOID: we look up the PUSH_INVOICE job by
 * unique (garageId, op, sourceId). The tailer processes the batch
 * in createdAt order and INVOICE writes always precede
 * PAYMENT/VOID temporally (payments and voids require an existing
 * invoice), so the invoice job is enqueued earlier in the same
 * pass OR in a prior pass. If not found → the tailer would throw;
 * that indicates ordering violation and is worth failing loudly
 * on rather than silently missing the dep.
 */
async function resolveDeps(args: {
    garageId: string;
    op: ErpSyncOp;
    sourceType: string;
    sourceId: string;
    tx: Prisma.TransactionClient;
}): Promise<string[]> {
    const { garageId, sourceType, sourceId, tx } = args;

    switch (sourceType) {
        case "INVOICE": {
            const inv = await tx.invoice.findUnique({
                where: { id: sourceId },
                select: {
                    jobCard: {
                        select: {
                            vehicle: { select: { customerId: true } },
                        },
                    },
                },
            });
            if (!inv) {
                throw new Error(`[erp-tailer] INVOICE ${sourceId} — source row missing`);
            }
            const custJob = await upsertCustomerJob(
                garageId,
                inv.jobCard.vehicle.customerId,
                tx,
            );
            return [custJob.id];
        }
        case "PAYMENT": {
            const pay = await tx.payment.findUnique({
                where: { id: sourceId },
                select: { invoiceId: true },
            });
            if (!pay) {
                throw new Error(`[erp-tailer] PAYMENT ${sourceId} — source row missing`);
            }
            const invJob = await tx.erpSyncJob.findUnique({
                where: {
                    garageId_op_sourceId: {
                        garageId,
                        op: "PUSH_INVOICE",
                        sourceId: pay.invoiceId,
                    },
                },
                select: { id: true },
            });
            if (!invJob) {
                throw new Error(
                    `[erp-tailer] PAYMENT ${sourceId} — PUSH_INVOICE for ${pay.invoiceId} not enqueued (ordering violation)`,
                );
            }
            return [invJob.id];
        }
        case "ADVANCE": {
            const adv = await tx.advancePayment.findUnique({
                where: { id: sourceId },
                select: {
                    jobCard: {
                        select: {
                            vehicle: { select: { customerId: true } },
                        },
                    },
                },
            });
            if (!adv) {
                throw new Error(`[erp-tailer] ADVANCE ${sourceId} — source row missing`);
            }
            const custJob = await upsertCustomerJob(
                garageId,
                adv.jobCard.vehicle.customerId,
                tx,
            );
            return [custJob.id];
        }
        case "INVOICE_VOID": {
            const invJob = await tx.erpSyncJob.findUnique({
                where: {
                    garageId_op_sourceId: {
                        garageId,
                        op: "PUSH_INVOICE",
                        sourceId,
                    },
                },
                select: { id: true },
            });
            if (!invJob) {
                throw new Error(
                    `[erp-tailer] INVOICE_VOID ${sourceId} — PUSH_INVOICE not enqueued (ordering violation)`,
                );
            }
            return [invJob.id];
        }
        default:
            return [];
    }
}

async function upsertCustomerJob(
    garageId: string,
    customerId: string,
    tx: Prisma.TransactionClient,
): Promise<{ id: string }> {
    return tx.erpSyncJob.upsert({
        where: {
            garageId_op_sourceId: {
                garageId,
                op: "PUSH_CUSTOMER",
                sourceId: customerId,
            },
        },
        create: {
            garageId,
            op: "PUSH_CUSTOMER",
            sourceType: "Customer",
            sourceId: customerId,
            dependsOnJobIds: [],
        },
        update: {},
        select: { id: true },
    });
}
