// ERPNext sync runner — picks PENDING ErpSyncJob rows whose
// dependencies are SYNCED, calls the appropriate pusher, and
// commits the entity-map row + job status flip in ONE transaction.
//
// The load-bearing contract (§7 of ERPNEXT_SYNC_BRIEF.md, "the
// one that corrupts ledgers"):
//
//   1. HTTP POST to ERPNext happens OUTSIDE the DB transaction.
//   2. The transaction contains ONLY the ErpEntityMap upsert and
//      the ErpSyncJob status update. Two DB writes, atomic.
//   3. A crash between (1) and (2) is safe because the pusher does
//      a pre-flight lookup FIRST — a prior POST that landed in
//      ERPNext but never committed its map row is found by the
//      pre-flight, the POST is skipped, and the tx runs on
//      recovery. See pushers.ts for the pre-flight shape.
//
// The pre-flight-hit case is logged distinctly (AR 2026-08-27):
//   `[erp-runner] PRE_FLIGHT_HIT garage=<id> op=<op> sourceId=<id>
//    erpnextName=<name>` — grep this to measure how often the
//   crash window actually fires. Zero hits over months → the window
//   is theoretical. Non-zero → real, and we know how often.

import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { ErpSyncOp } from "@/generated/prisma/enums";
import { prisma as defaultPrisma } from "@/lib/prisma";
import {
    resolveCredentials,
    tryResolveCredentials,
    type ErpNextCredentials,
} from "@/lib/erp-sync/credentials";
import { pushCustomer, type PushResult } from "@/lib/erp-sync/pushers";

const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 5;
const MAX_JOBS_PER_PASS = 100;

export type RunnerJobResult =
    | {
        garageId: string;
        jobId: string;
        op: ErpSyncOp;
        status: "SYNCED";
        preflightHit: boolean;
        erpnextName: string;
    }
    | {
        garageId: string;
        jobId: string;
        op: ErpSyncOp;
        status: "FAILED" | "DEAD_LETTER";
        error: string;
    }
    | {
        garageId: string;
        jobId: string;
        op: ErpSyncOp;
        status: "BLOCKED_DEPS";
    }
    | {
        garageId: string;
        jobId: string;
        op: ErpSyncOp;
        status: "SKIPPED_NOT_IMPLEMENTED";
    };

export type RunnerPassResult = {
    garageId: string;
    status: "advanced" | "quiet" | "skipped-missing-credentials" | "skipped-not-enabled";
    processed: number;
    synced: number;
    preflightHits: number;
    failed: number;
    deadLettered: number;
    blocked: number;
    skippedNotImplemented: number;
    missingEnvs?: string[];
    results: RunnerJobResult[];
};

export async function runOnePass(
    garageId: string,
    client: PrismaClient = defaultPrisma,
    opts?: { fetchImpl?: typeof fetch },
): Promise<RunnerPassResult> {
    const garage = await client.garage.findUnique({
        where: { id: garageId },
        select: { erpSyncEnabled: true },
    });
    if (!garage || !garage.erpSyncEnabled) {
        return {
            garageId,
            status: "skipped-not-enabled",
            processed: 0,
            synced: 0,
            preflightHits: 0,
            failed: 0,
            deadLettered: 0,
            blocked: 0,
            skippedNotImplemented: 0,
            results: [],
        };
    }

    const credResult = tryResolveCredentials(garageId);
    if (!credResult.ok) {
        // Same greppable shape as the tailer's missing-cursor line
        // so ops sees both anomalies through one grep.
        console.warn(
            `[erp-runner] SKIPPED garage=${garageId} reason=missing-credentials envs=${credResult.missing.join(",")}`,
        );
        return {
            garageId,
            status: "skipped-missing-credentials",
            processed: 0,
            synced: 0,
            preflightHits: 0,
            failed: 0,
            deadLettered: 0,
            blocked: 0,
            skippedNotImplemented: 0,
            missingEnvs: credResult.missing,
            results: [],
        };
    }
    const creds = credResult.creds;

    // Read a batch of PENDING jobs for this garage, oldest first.
    // The runner processes them serially — Frappe's write throughput
    // is the bottleneck, and serial processing keeps the pre-flight
    // ordering deterministic (a customer job that just landed is
    // seen by the next invoice job's dep check).
    const jobs = await client.erpSyncJob.findMany({
        where: { garageId, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: MAX_JOBS_PER_PASS,
    });

    const results: RunnerJobResult[] = [];
    for (const job of jobs) {
        const res = await runOneJob(job.id, client, { creds, fetchImpl: opts?.fetchImpl });
        results.push(res);
    }

    const synced = results.filter((r) => r.status === "SYNCED").length;
    const preflightHits = results
        .filter((r): r is Extract<RunnerJobResult, { status: "SYNCED" }> => r.status === "SYNCED")
        .filter((r) => r.preflightHit).length;
    const failed = results.filter((r) => r.status === "FAILED").length;
    const deadLettered = results.filter((r) => r.status === "DEAD_LETTER").length;
    const blocked = results.filter((r) => r.status === "BLOCKED_DEPS").length;
    const skippedNotImplemented = results.filter((r) => r.status === "SKIPPED_NOT_IMPLEMENTED").length;

    return {
        garageId,
        status: jobs.length === 0 ? "quiet" : "advanced",
        processed: jobs.length,
        synced,
        preflightHits,
        failed,
        deadLettered,
        blocked,
        skippedNotImplemented,
        results,
    };
}

/**
 * Run one job by id. Reads the job row fresh (in case it was
 * status-updated between the outer batch read and now), checks dep
 * gate, dispatches to a pusher, commits map+status atomically.
 *
 * Exported so tests can drive one job in isolation.
 */
export async function runOneJob(
    jobId: string,
    client: PrismaClient,
    ctx: { creds: ErpNextCredentials; fetchImpl?: typeof fetch },
): Promise<RunnerJobResult> {
    const job = await client.erpSyncJob.findUnique({
        where: { id: jobId },
    });
    if (!job) throw new Error(`[erp-runner] job ${jobId} not found`);
    if (job.status !== "PENDING") {
        // Race: another runner picked it up. Treat as no-op.
        return {
            garageId: job.garageId,
            jobId: job.id,
            op: job.op,
            status: job.status === "SYNCED" ? "SYNCED" : "BLOCKED_DEPS",
            preflightHit: false,
            erpnextName: "",
        } as RunnerJobResult;
    }

    // Dep gate. Every listed dep id must be SYNCED. If any is
    // FAILED / DEAD_LETTER / PENDING, we do NOT run this job.
    // Serial processing means a dep synced in this same pass IS
    // visible here.
    if (job.dependsOnJobIds.length > 0) {
        const deps = await client.erpSyncJob.findMany({
            where: { id: { in: job.dependsOnJobIds } },
            select: { id: true, status: true },
        });
        const notReady = deps.filter((d) => d.status !== "SYNCED");
        if (notReady.length > 0 || deps.length !== job.dependsOnJobIds.length) {
            return {
                garageId: job.garageId,
                jobId: job.id,
                op: job.op,
                status: "BLOCKED_DEPS",
            };
        }
    }

    // Dispatch. Phase 3 handles PUSH_CUSTOMER; every other op is
    // left PENDING with a distinct log line — Phase 5 wires the
    // invoice / payment / advance / void pushers.
    try {
        const result = await dispatch(job, ctx);
        if (!result) {
            // SKIPPED_NOT_IMPLEMENTED — do not touch the job row.
            // It sits PENDING until Phase 5 lands.
            return {
                garageId: job.garageId,
                jobId: job.id,
                op: job.op,
                status: "SKIPPED_NOT_IMPLEMENTED",
            };
        }

        if (result.preflightHit) {
            console.warn(
                `[erp-runner] PRE_FLIGHT_HIT garage=${job.garageId} op=${job.op} sourceId=${job.sourceId} erpnextName=${result.erpnextName} — prior POST landed but map/status commit didn't complete; recovering`,
            );
        }

        // The load-bearing atomic commit. Both writes or neither.
        await client.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.erpEntityMap.upsert({
                where: {
                    garageId_garageosDoctype_garageosId: {
                        garageId: job.garageId,
                        garageosDoctype: job.sourceType,
                        garageosId: job.sourceId,
                    },
                },
                create: {
                    garageId: job.garageId,
                    garageosDoctype: job.sourceType,
                    garageosId: job.sourceId,
                    erpnextDoctype: erpnextDoctypeFor(job.op),
                    erpnextName: result.erpnextName,
                    version: 1,
                },
                update: {
                    erpnextName: result.erpnextName,
                    version: { increment: 1 },
                },
            });
            await tx.erpSyncJob.update({
                where: { id: job.id },
                data: {
                    status: "SYNCED",
                    syncedAt: new Date(),
                    attempts: { increment: 1 },
                    lastError: null,
                    lastErrorField: null,
                },
            });
        });

        return {
            garageId: job.garageId,
            jobId: job.id,
            op: job.op,
            status: "SYNCED",
            preflightHit: result.preflightHit,
            erpnextName: result.erpnextName,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const nextAttempts = job.attempts + 1;
        const nextStatus =
            nextAttempts >= MAX_ATTEMPTS_BEFORE_DEAD_LETTER ? "DEAD_LETTER" : "FAILED";
        await client.erpSyncJob.update({
            where: { id: job.id },
            data: {
                status: nextStatus,
                attempts: nextAttempts,
                lastError: msg.slice(0, 4000),
            },
        });
        console.error(
            `[erp-runner] ${nextStatus} garage=${job.garageId} op=${job.op} sourceId=${job.sourceId} attempts=${nextAttempts} err=${msg}`,
        );
        return {
            garageId: job.garageId,
            jobId: job.id,
            op: job.op,
            status: nextStatus,
            error: msg,
        };
    }
}

/**
 * Dispatch to the pusher for this op. Returns null for ops Phase 3
 * doesn't yet implement (Phase 5 territory).
 */
async function dispatch(
    job: {
        id: string;
        garageId: string;
        op: ErpSyncOp;
        sourceType: string;
        sourceId: string;
    },
    ctx: { creds: ErpNextCredentials; fetchImpl?: typeof fetch },
): Promise<PushResult | null> {
    switch (job.op) {
        case "PUSH_CUSTOMER": {
            const cust = await defaultPrisma.customer.findUnique({
                where: { id: job.sourceId },
                select: { id: true, name: true, phone: true, trn: true },
            });
            if (!cust) {
                throw new Error(`[erp-runner] Customer ${job.sourceId} not found`);
            }
            return pushCustomer(ctx.creds, cust, { fetchImpl: ctx.fetchImpl });
        }
        case "PUSH_ITEM":
        case "PUSH_INVOICE":
        case "PUSH_PAYMENT":
        case "PUSH_ADVANCE":
        case "PUSH_VOID":
        case "APPLY_DEPOSIT":
            // Phase 5 territory. Distinct log so ops can see the
            // build-up of not-yet-implemented ops before Phase 5
            // lands.
            console.log(
                `[erp-runner] SKIPPED_NOT_IMPLEMENTED garage=${job.garageId} op=${job.op} sourceId=${job.sourceId} — Phase 5 territory`,
            );
            return null;
    }
}

function erpnextDoctypeFor(op: ErpSyncOp): string {
    switch (op) {
        case "PUSH_CUSTOMER":
            return "Customer";
        case "PUSH_ITEM":
            return "Item";
        case "PUSH_INVOICE":
        case "PUSH_VOID":
        case "APPLY_DEPOSIT":
            return "Sales Invoice";
        case "PUSH_PAYMENT":
        case "PUSH_ADVANCE":
            return "Payment Entry";
    }
}

// Suppress unused-import warnings for the exported symbol.
export type { ErpNextCredentials };
export { resolveCredentials };
