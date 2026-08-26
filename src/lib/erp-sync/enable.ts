// Atomic enable / disable of ERPNext sync for one garage.
//
// See ERPNEXT_SYNC_BRIEF.md §1 constraint 5 ("behind a per-garage
// flag, off by default"). Two rows land together or neither does:
//   - Garage.erpSyncEnabled = true
//   - ErpSyncCursor row for that garage, with lastLedgerCreatedAt =
//     startAt
//
// Default startAt = now, NOT epoch. Enabling ERPNext sync mid-life
// should not silently backfill three months of historical invoices
// into ERPNext — that would land as a surprise on the accountant's
// side, and every historical customer/item would need to be pushed
// as a dependency first. Backfill is a deliberate operator choice:
// pass an explicit past `startAt` when the shop actually wants their
// history in ERPNext.
//
// Symmetric disable: flips the flag off, LEAVES the cursor in place.
// A shop that pauses for a dispute and resumes doesn't skip the
// dispute window's events. To clear history and restart-from-now,
// delete the ErpSyncCursor row explicitly then re-enable.

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

export type EnableArgs = {
    garageId: string;
    /**
     * The tailer picks up ledger rows with (createdAt, id) STRICTLY
     * GREATER THAN (startAt, ""). Defaults to `new Date()` — the
     * FIRST ledger row created after this call is the first thing
     * synced. Pass a past Date to backfill deliberately.
     */
    startAt?: Date;
    prisma?: PrismaClient;
};

export async function enableErpSyncForGarage(args: EnableArgs): Promise<{
    garageId: string;
    startAt: Date;
    cursorCreated: boolean;
}> {
    const { garageId } = args;
    const startAt = args.startAt ?? new Date();
    const client = args.prisma ?? defaultPrisma;

    return client.$transaction(async (tx: Prisma.TransactionClient) => {
        const garage = await tx.garage.findUnique({
            where: { id: garageId },
            select: { id: true, erpSyncEnabled: true },
        });
        if (!garage) {
            throw new Error(`[erp-enable] garage ${garageId} not found`);
        }

        await tx.garage.update({
            where: { id: garageId },
            data: { erpSyncEnabled: true },
        });

        // Cursor initialization is idempotent-ish: if a cursor row
        // already exists (from a previous enable that was later
        // disabled), we do NOT overwrite it — resuming from the last
        // synced position is the intended default (see head comment).
        // Explicit re-seeding to "now" requires deleting the cursor
        // row first.
        const existing = await tx.erpSyncCursor.findUnique({
            where: { garageId },
        });
        if (existing) {
            return { garageId, startAt: existing.lastLedgerCreatedAt, cursorCreated: false };
        }

        await tx.erpSyncCursor.create({
            data: {
                garageId,
                lastLedgerCreatedAt: startAt,
                lastLedgerId: "",
            },
        });
        return { garageId, startAt, cursorCreated: true };
    });
}

export async function disableErpSyncForGarage(
    args: { garageId: string; prisma?: PrismaClient },
): Promise<void> {
    const client = args.prisma ?? defaultPrisma;
    await client.garage.update({
        where: { id: args.garageId },
        data: { erpSyncEnabled: false },
    });
}
