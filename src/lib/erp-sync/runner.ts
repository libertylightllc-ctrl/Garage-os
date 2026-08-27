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
import {
    pushCustomer,
    pushInvoice,
    pushPayment,
    pushAdvance,
    pushVoid,
    type PushResult,
    type InvoicePushInput,
} from "@/lib/erp-sync/pushers";

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

    // Dispatch. Phase 3 handled PUSH_CUSTOMER; Phase 4 (this
    // commit) adds PUSH_INVOICE / PUSH_PAYMENT / PUSH_ADVANCE /
    // PUSH_VOID. PUSH_ITEM and APPLY_DEPOSIT stay SKIPPED_NOT_
    // IMPLEMENTED — Items are read-only (§6, four pre-seeded on
    // the instance) and APPLY_DEPOSIT is handled implicitly by
    // allocate_advances_automatically=1 on the pushed invoice.
    try {
        const result = await dispatchJob(job, ctx);
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
        // Pushers tag specific assertion failures (§5b outstanding
        // mismatch, §5a PLE-row missing) with an err.field property
        // so the operator surface can render "the failing field was
        // outstanding_amount" instead of the full stack.
        const field =
            err instanceof Error && "field" in err
                ? String((err as Error & { field?: unknown }).field ?? "")
                : "";
        const nextAttempts = job.attempts + 1;
        const nextStatus =
            nextAttempts >= MAX_ATTEMPTS_BEFORE_DEAD_LETTER ? "DEAD_LETTER" : "FAILED";
        await client.erpSyncJob.update({
            where: { id: job.id },
            data: {
                status: nextStatus,
                attempts: nextAttempts,
                lastError: msg.slice(0, 4000),
                lastErrorField: field || null,
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
 * Dispatch to the pusher for this op. Returns null for ops we
 * deliberately don't implement (PUSH_ITEM read-only, APPLY_DEPOSIT
 * handled implicitly by allocate_advances_automatically=1).
 *
 * Renamed from `dispatch` (AR 2026-08-27 Q2) — clearer name, and
 * the parallel with `runTailer` is worth keeping.
 */
async function dispatchJob(
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
        case "PUSH_INVOICE": {
            const input = await buildInvoiceInput(job.garageId, job.sourceId);
            return pushInvoice(ctx.creds, input, { fetchImpl: ctx.fetchImpl });
        }
        case "PUSH_PAYMENT": {
            const pay = await defaultPrisma.payment.findUnique({
                where: { id: job.sourceId },
                select: {
                    id: true,
                    amount: true,
                    paidAt: true,
                    invoiceId: true,
                    invoice: {
                        select: {
                            jobCard: {
                                select: {
                                    vehicle: { select: { customerId: true } },
                                },
                            },
                        },
                    },
                },
            });
            if (!pay) throw new Error(`[erp-runner] Payment ${job.sourceId} not found`);
            const invoiceErpnextName = await resolveMap(
                job.garageId,
                "Invoice",
                pay.invoiceId,
            );
            const customerErpnextName = await resolveMap(
                job.garageId,
                "Customer",
                pay.invoice.jobCard.vehicle.customerId,
            );
            return pushPayment(
                ctx.creds,
                {
                    id: pay.id,
                    amount: Number(pay.amount),
                    paidAt: pay.paidAt,
                    invoiceErpnextName,
                    customerErpnextName,
                },
                { fetchImpl: ctx.fetchImpl },
            );
        }
        case "PUSH_ADVANCE": {
            const adv = await defaultPrisma.advancePayment.findUnique({
                where: { id: job.sourceId },
                select: {
                    id: true,
                    amount: true,
                    receivedAt: true,
                    jobCard: {
                        select: { vehicle: { select: { customerId: true } } },
                    },
                },
            });
            if (!adv) throw new Error(`[erp-runner] AdvancePayment ${job.sourceId} not found`);
            const customerErpnextName = await resolveMap(
                job.garageId,
                "Customer",
                adv.jobCard.vehicle.customerId,
            );
            return pushAdvance(
                ctx.creds,
                {
                    id: adv.id,
                    amount: Number(adv.amount),
                    receivedAt: adv.receivedAt,
                    customerErpnextName,
                },
                { fetchImpl: ctx.fetchImpl },
            );
        }
        case "PUSH_VOID": {
            const inv = await defaultPrisma.invoice.findUnique({
                where: { id: job.sourceId },
                select: {
                    id: true,
                    subtotal: true,
                    vatAmount: true,
                    total: true,
                    voidedAt: true,
                    lines: {
                        select: {
                            kind: true,
                            description: true,
                            qty: true,
                            unitPrice: true,
                        },
                        orderBy: { createdAt: "asc" },
                    },
                    jobCard: {
                        select: {
                            vehicle: { select: { customerId: true } },
                        },
                    },
                },
            });
            if (!inv) throw new Error(`[erp-runner] Invoice ${job.sourceId} not found`);
            if (!inv.voidedAt) {
                throw new Error(
                    `[erp-runner] PUSH_VOID for ${job.sourceId} but invoice.voidedAt is null`,
                );
            }
            const originalErpnextName = await resolveMap(
                job.garageId,
                "Invoice",
                inv.id,
            );
            const customerErpnextName = await resolveMap(
                job.garageId,
                "Customer",
                inv.jobCard.vehicle.customerId,
            );
            return pushVoid(
                ctx.creds,
                {
                    originalInvoiceId: inv.id,
                    originalErpnextName,
                    total: Number(inv.total),
                    subtotal: Number(inv.subtotal),
                    vatAmount: Number(inv.vatAmount),
                    voidedAt: inv.voidedAt,
                    customerErpnextName,
                    lines: inv.lines.map((l) => ({
                        kind: l.kind,
                        description: l.description,
                        qty: Number(l.qty),
                        unitPrice: Number(l.unitPrice),
                    })),
                },
                { fetchImpl: ctx.fetchImpl },
            );
        }
        case "PUSH_ITEM":
            // Items are pre-seeded on the instance (§6). Nothing
            // enqueues PUSH_ITEM in Phase 2 today, but the enum
            // value is reserved. Log distinctly if one ever appears.
            console.log(
                `[erp-runner] SKIPPED_NOT_IMPLEMENTED garage=${job.garageId} op=PUSH_ITEM sourceId=${job.sourceId} — Items are read-only, pre-seeded on the instance (§6)`,
            );
            return null;
        case "APPLY_DEPOSIT":
            // Handled implicitly by allocate_advances_automatically=1
            // on PUSH_INVOICE (§4 "Deposit applied: no separate
            // document"). Nothing enqueues APPLY_DEPOSIT in Phase 2
            // today. Log if one appears — indicates the tailer or
            // an operator produced a job that has no producer.
            console.log(
                `[erp-runner] SKIPPED_NOT_IMPLEMENTED garage=${job.garageId} op=APPLY_DEPOSIT sourceId=${job.sourceId} — handled implicitly by allocate_advances_automatically on PUSH_INVOICE`,
            );
            return null;
    }
}

/**
 * Look up an ErpEntityMap row and return the ERPNext name. Throws
 * if the map row is missing — the runner's dep gate should have
 * kept us from getting here, so a missing map row means either a
 * corrupt DB state or a code bug.
 */
async function resolveMap(
    garageId: string,
    garageosDoctype: string,
    garageosId: string,
): Promise<string> {
    const row = await defaultPrisma.erpEntityMap.findUnique({
        where: {
            garageId_garageosDoctype_garageosId: {
                garageId,
                garageosDoctype,
                garageosId,
            },
        },
        select: { erpnextName: true },
    });
    if (!row) {
        throw new Error(
            `[erp-runner] ErpEntityMap miss garage=${garageId} doctype=${garageosDoctype} garageosId=${garageosId} — dep should have blocked us`,
        );
    }
    return row.erpnextName;
}

/**
 * Assemble the InvoicePushInput from GarageOS-side state.
 *
 * expectedAllocation = sum of amounts on Payment rows whose row
 * originated as an ADVANCE_MIGRATION (i.e. an AdvancePayment was
 * merged onto this invoice at generation time). Those advances were
 * already pushed to ERPNext as Payment Entries; when we push the
 * invoice with allocate_advances_automatically=1, ERPNext should
 * apply them and outstanding_amount should drop by exactly that sum.
 *
 * We detect the migration by walking AdvancePayment rows where
 * migratedAt is not null and paymentId points to a Payment row on
 * this invoice.
 */
async function buildInvoiceInput(
    garageId: string,
    invoiceId: string,
): Promise<InvoicePushInput> {
    const inv = await defaultPrisma.invoice.findUnique({
        where: { id: invoiceId },
        select: {
            id: true,
            subtotal: true,
            vatAmount: true,
            total: true,
            issuedAt: true,
            dueDate: true,
            lines: {
                select: {
                    kind: true,
                    description: true,
                    qty: true,
                    unitPrice: true,
                },
                orderBy: { createdAt: "asc" },
            },
            payments: { select: { id: true, amount: true } },
            jobCard: {
                select: {
                    vehicle: { select: { customerId: true } },
                },
            },
        },
    });
    if (!inv) throw new Error(`[erp-runner] Invoice ${invoiceId} not found`);

    const customerErpnextName = await resolveMap(
        garageId,
        "Customer",
        inv.jobCard.vehicle.customerId,
    );

    // Advances that were migrated into Payment rows on this invoice.
    const migratedAdvances = inv.payments.length
        ? await defaultPrisma.advancePayment.findMany({
              where: {
                  paymentId: { in: inv.payments.map((p) => p.id) },
                  migratedAt: { not: null },
              },
              select: { amount: true },
          })
        : [];
    const expectedAllocation = migratedAdvances.reduce(
        (n, a) => n + Number(a.amount),
        0,
    );

    return {
        id: inv.id,
        total: Number(inv.total),
        subtotal: Number(inv.subtotal),
        vatAmount: Number(inv.vatAmount),
        issuedAt: inv.issuedAt,
        dueDate: inv.dueDate,
        customerErpnextName,
        expectedAllocation: Math.round((expectedAllocation + Number.EPSILON) * 100) / 100,
        lines: inv.lines.map((l) => ({
            kind: l.kind,
            description: l.description,
            qty: Number(l.qty),
            unitPrice: Number(l.unitPrice),
        })),
    };
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
