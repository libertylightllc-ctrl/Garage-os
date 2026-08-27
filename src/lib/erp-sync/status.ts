// Sync-status resolver — reads the PUSH_INVOICE / PUSH_PAYMENT /
// PUSH_ADVANCE / PUSH_VOID job(s) tied to a source doc and rolls
// them into a single status colour for UI rendering.
//
// Green / amber / red mapping (see brief §8 "Sync status chips"):
//   SYNCED           → green
//   PENDING/RUNNING  → amber
//   FAILED/DEAD      → red
//   no job / disabled → grey (surface as "not synced" hint)

import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

export type SyncBadge = "green" | "amber" | "red" | "grey";

export type InvoiceSyncStatus = {
    badge: SyncBadge;
    /** Human-readable one-liner for tooltip. */
    hint: string;
    /** Present only when badge is red — the field/error the pusher tagged. */
    errorField: string | null;
    lastError: string | null;
    jobId: string | null;
    syncedAt: Date | null;
    /** ERPNext-side name if we have it. */
    erpnextName: string | null;
};

/**
 * Roll every job tied to an Invoice into ONE badge. An invoice
 * synced but with a payment stuck in RETRY is still amber overall
 * (the invoice document does exist on ERPNext but the shop's
 * receivables report is wrong until payment lands).
 */
export async function getInvoiceSyncStatus(
    garageId: string,
    invoiceId: string,
    client: PrismaClient = defaultPrisma,
): Promise<InvoiceSyncStatus> {
    // 1. Is sync even enabled for this garage?
    const garage = await client.garage.findUnique({
        where: { id: garageId },
        select: { erpSyncEnabled: true },
    });
    if (!garage?.erpSyncEnabled) {
        return {
            badge: "grey",
            hint: "ERPNext sync is off for this shop",
            errorField: null,
            lastError: null,
            jobId: null,
            syncedAt: null,
            erpnextName: null,
        };
    }

    // 2. Pull every job whose source doc is this invoice OR the
    // payments/advances tied to it.
    const paymentIds = (
        await client.payment.findMany({
            where: { invoiceId },
            select: { id: true },
        })
    ).map((p) => p.id);

    // Include the ADVANCE_MIGRATION path: advances that migrated
    // onto this invoice have their own PUSH_ADVANCE job under the
    // original AdvancePayment.id (§7 of the brief — the mapping key).
    const advanceIds = paymentIds.length
        ? (
              await client.advancePayment.findMany({
                  where: {
                      paymentId: { in: paymentIds },
                      migratedAt: { not: null },
                  },
                  select: { id: true },
              })
          ).map((a) => a.id)
        : [];

    const relatedIds = [invoiceId, ...paymentIds, ...advanceIds];
    const jobs = await client.erpSyncJob.findMany({
        where: {
            garageId,
            sourceId: { in: relatedIds },
        },
        orderBy: { createdAt: "asc" },
    });

    // The invoice's own PUSH_INVOICE (or PUSH_VOID for a voided
    // invoice) is the primary status carrier.
    const primary =
        jobs.find(
            (j) => j.sourceId === invoiceId && (j.op === "PUSH_INVOICE" || j.op === "PUSH_VOID"),
        ) ?? null;

    if (!primary) {
        return {
            badge: "grey",
            hint: "No sync job for this invoice yet — the tailer may not have caught up.",
            errorField: null,
            lastError: null,
            jobId: null,
            syncedAt: null,
            erpnextName: null,
        };
    }

    // Look up the entity-map row for the ERPNext-side name.
    const mapRow = await client.erpEntityMap.findUnique({
        where: {
            garageId_garageosDoctype_garageosId: {
                garageId,
                garageosDoctype: "Invoice",
                garageosId: invoiceId,
            },
        },
        select: { erpnextName: true },
    });

    // Roll every job's status into a single badge. Any FAILED/DEAD
    // in the chain → red. Any PENDING/RUNNING → amber. All SYNCED
    // → green.
    let badge: SyncBadge = "green";
    let hint = `Synced to ERPNext${mapRow ? ` as ${mapRow.erpnextName}` : ""}`;
    let errorField: string | null = null;
    let lastError: string | null = null;

    const failed = jobs.find((j) => j.status === "FAILED" || j.status === "DEAD_LETTER");
    const pending = jobs.find((j) => j.status === "PENDING" || j.status === "RUNNING");

    if (failed) {
        badge = "red";
        hint = failed.lastErrorField
            ? `Sync failed on field: ${failed.lastErrorField}`
            : "Sync failed — see error detail on the sync page";
        errorField = failed.lastErrorField;
        lastError = failed.lastError;
    } else if (pending) {
        badge = "amber";
        hint = pending.op === "PUSH_INVOICE"
            ? "Sync in progress"
            : `Waiting on ${pending.op}`;
    }

    return {
        badge,
        hint,
        errorField,
        lastError,
        jobId: primary.id,
        syncedAt: primary.syncedAt,
        erpnextName: mapRow?.erpnextName ?? null,
    };
}

/**
 * Owner-page summary counts by status for a garage.
 */
export async function getSyncSummary(
    garageId: string,
    client: PrismaClient = defaultPrisma,
): Promise<{
    pending: number;
    running: number;
    synced: number;
    failed: number;
    deadLettered: number;
}> {
    const rows = await client.erpSyncJob.groupBy({
        by: ["status"],
        where: { garageId },
        _count: { _all: true },
    });
    const out = { pending: 0, running: 0, synced: 0, failed: 0, deadLettered: 0 };
    for (const r of rows) {
        switch (r.status) {
            case "PENDING":
                out.pending = r._count._all;
                break;
            case "RUNNING":
                out.running = r._count._all;
                break;
            case "SYNCED":
                out.synced = r._count._all;
                break;
            case "FAILED":
                out.failed = r._count._all;
                break;
            case "DEAD_LETTER":
                out.deadLettered = r._count._all;
                break;
        }
    }
    return out;
}
