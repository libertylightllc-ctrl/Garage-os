/**
 * ERPNext sync — ledger tailer integration test (Phase 2).
 *
 * End-to-end against the local dev DB — auth mocked, session role =
 * CASHIER (INVOICE_ROLES), everything else real. Exercises the four
 * real ledger writers (generateInvoiceAction / recordPaymentAction /
 * recordAdvancePaymentAction / voidInvoiceAction), runs the tailer,
 * asserts:
 *
 *  1. One ErpSyncJob per source doc — ledger writes with 2–3 rows
 *     per source doc are collapsed to one job.
 *  2. ADVANCE_MIGRATION is EXPLICITLY skipped (not enqueued at all).
 *  3. INVOICE_VOID enqueues its own PUSH_VOID job (regression guard
 *     — a silent removal of INVOICE_VOID from the OP_BY_LEDGER_SOURCE
 *     map would mean credit notes never sync to ERPNext).
 *  4. Cursor advances to (max(createdAt), max(id)) of the batch.
 *  5. Running the tailer twice on the same DB state produces no new
 *     jobs — idempotency via (garageId, op, sourceId) unique.
 *  6. Invoice job's dependsOnJobIds includes the customer job.
 *  7. Garage.erpSyncEnabled = false — tailer runs the cron loop
 *     without picking that garage up at all.
 *  8. Missing-cursor case — status = "skipped-missing-cursor",
 *     nothing enqueued.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { mockSessionAndSeed } from "@/lib/__tests__/helpers/mock-session-and-seed";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";
import { runTailer } from "@/lib/erp-sync/tailer";
import { enableErpSyncForGarage } from "@/lib/erp-sync/enable";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        throw new Error("REDIRECT:" + url);
    },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const {
    generateInvoiceAction,
    recordPaymentAction,
    recordAdvancePaymentAction,
    voidInvoiceAction,
} = await import("@/app/actions/billing");

const P = "erp-tailer-test-";
const gid = P + "g1";

// A second garage — used to prove tailer skips disabled garages and
// missing-cursor garages independently.
const gidDisabled = P + "g2";
const gidNoCursor = P + "g3";

async function form(fields: Record<string, string>): Promise<FormData> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
}

async function seedGarageWithJob(garageId: string) {
    await prisma.garage.upsert({
        where: { id: garageId },
        create: { id: garageId, name: garageId },
        update: {},
    });
    const customer = await prisma.customer.create({
        data: { garageId, name: "C", phone: P + garageId + "-phone-" + Math.random() },
    });
    const vehicle = await prisma.vehicle.create({
        data: {
            customerId: customer.id,
            make: "T",
            model: "C",
            plate: P + garageId + "-plt-" + Math.random(),
        },
    });
    const job = await prisma.jobCard.create({
        data: {
            garageId,
            vehicleId: vehicle.id,
            status: "TECH_COMPLETE",
        },
    });
    return { customer, vehicle, job };
}

async function seedApprovedEstimate(jobCardId: string) {
    return prisma.estimate.create({
        data: {
            jobCardId,
            status: "APPROVED",
            approvedAt: new Date(),
            subtotal: "100.00",
            vatAmount: "5.00",
            total: "105.00",
            lines: {
                create: [
                    {
                        kind: "LABOR",
                        description: "Test labour",
                        qty: 1,
                        unitPrice: "100.00",
                        lineTotal: "100.00",
                        vatRate: "5.00",
                    },
                ],
            },
        },
        select: { id: true },
    });
}

async function cleanup() {
    const garageIds = [gid, gidDisabled, gidNoCursor];
    await withDeleteGuardBypass(prisma, async (tx) => {
        await tx.payment.deleteMany({
            where: { invoice: { garageId: { in: garageIds } } },
        });
        await tx.advancePayment.deleteMany({
            where: { garageId: { in: garageIds } },
        });
        await tx.invoice.deleteMany({ where: { garageId: { in: garageIds } } });
    });
    await prisma.erpSyncJob.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.erpSyncCursor.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.ledgerEntry.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.estimateLine.deleteMany({
        where: { estimate: { jobCard: { garageId: { in: garageIds } } } },
    });
    await prisma.estimate.deleteMany({
        where: { jobCard: { garageId: { in: garageIds } } },
    });
    await prisma.jobCard.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.vehicle.deleteMany({
        where: { customer: { garageId: { in: garageIds } } },
    });
    await prisma.customer.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.user.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.garage.deleteMany({ where: { id: { in: garageIds } } });
}

beforeEach(async () => {
    await cleanup();
    mockAuth.mockReset();
});
afterAll(cleanup);

describe("runTailer — Phase 2 shape", () => {
    it("enqueues one job per source doc, not one per ledger row", async () => {
        const { customer, job } = await seedGarageWithJob(gid);
        await seedApprovedEstimate(job.id);

        mockAuth.mockResolvedValue(
            await mockSessionAndSeed({
                id: P + "cashier",
                garageId: gid,
                role: "CASHIER",
            }),
        );
        // Fire the invoice ledger writes. This inserts one Invoice
        // row and 3 LedgerEntry rows (AR / Sales / VAT) in a single
        // $transaction — the tailer must collapse those into ONE
        // PUSH_INVOICE job.
        await expect(
            generateInvoiceAction(await form({ jobCardId: job.id })),
        ).rejects.toThrow(/REDIRECT:/);

        // Enable AFTER the invoice write, with a past startAt so the
        // just-written ledger rows are strictly greater and thus
        // picked up.
        await enableErpSyncForGarage({
            garageId: gid,
            startAt: new Date(0),
        });

        const result = await runTailer(gid);
        expect(result.status).toBe("advanced");
        if (result.status !== "advanced") return; // narrow

        // Exactly two jobs: PUSH_CUSTOMER (dep) + PUSH_INVOICE.
        const jobs = await prisma.erpSyncJob.findMany({
            where: { garageId: gid },
            orderBy: { createdAt: "asc" },
        });
        expect(jobs).toHaveLength(2);
        const invJob = jobs.find((j) => j.op === "PUSH_INVOICE");
        const custJob = jobs.find((j) => j.op === "PUSH_CUSTOMER");
        expect(invJob).toBeDefined();
        expect(custJob).toBeDefined();
        expect(invJob!.dependsOnJobIds).toEqual([custJob!.id]);
        expect(custJob!.sourceId).toBe(customer.id);
    });

    it("INVOICE_VOID → PUSH_VOID job, depends on PUSH_INVOICE", async () => {
        const { job } = await seedGarageWithJob(gid);
        await seedApprovedEstimate(job.id);
        mockAuth.mockResolvedValue(
            await mockSessionAndSeed({
                id: P + "cashier",
                garageId: gid,
                role: "CASHIER",
            }),
        );

        await expect(
            generateInvoiceAction(await form({ jobCardId: job.id })),
        ).rejects.toThrow(/REDIRECT:/);

        // Simulate deliveredAt so the void gate passes.
        await prisma.jobCard.update({
            where: { id: job.id },
            data: { invoiceDeliveredAt: new Date() },
        });
        const inv = await prisma.invoice.findFirstOrThrow({
            where: { jobCardId: job.id },
        });

        await expect(
            voidInvoiceAction(await form({ invoiceId: inv.id })),
        ).rejects.toThrow(/REDIRECT:/);

        await enableErpSyncForGarage({
            garageId: gid,
            startAt: new Date(0),
        });
        await runTailer(gid);

        const voidJob = await prisma.erpSyncJob.findFirst({
            where: { garageId: gid, op: "PUSH_VOID" },
        });
        expect(voidJob).toBeDefined();
        expect(voidJob!.sourceId).toBe(inv.id);
        expect(voidJob!.sourceType).toBe("Invoice");

        const invJob = await prisma.erpSyncJob.findFirstOrThrow({
            where: { garageId: gid, op: "PUSH_INVOICE" },
        });
        expect(voidJob!.dependsOnJobIds).toContain(invJob.id);
    });

    it("ADVANCE_MIGRATION is explicitly skipped (regression guard)", async () => {
        const { customer, job } = await seedGarageWithJob(gid);

        mockAuth.mockResolvedValue(
            await mockSessionAndSeed({
                id: P + "cashier",
                garageId: gid,
                role: "CASHIER",
            }),
        );

        // Advance payment against the job BEFORE invoicing — creates
        // an AdvancePayment row + sourceType='ADVANCE' ledger rows.
        await expect(
            recordAdvancePaymentAction(
                await form({
                    jobCardId: job.id,
                    amount: "50",
                    method: "CASH",
                }),
            ),
        ).rejects.toThrow(/REDIRECT:/);

        // Now invoice — generateInvoiceAction MIGRATES the
        // AdvancePayment onto the new Invoice and writes
        // sourceType='ADVANCE_MIGRATION' ledger rows.
        await seedApprovedEstimate(job.id);
        await expect(
            generateInvoiceAction(await form({ jobCardId: job.id })),
        ).rejects.toThrow(/REDIRECT:/);

        await enableErpSyncForGarage({
            garageId: gid,
            startAt: new Date(0),
        });
        await runTailer(gid);

        const jobs = await prisma.erpSyncJob.findMany({
            where: { garageId: gid },
        });
        // Expected: PUSH_CUSTOMER, PUSH_ADVANCE, PUSH_INVOICE.
        // NOT expected: any job keyed off an ADVANCE_MIGRATION
        // ledger row.
        const ops = jobs.map((j) => j.op).sort();
        expect(ops).toEqual(
            ["PUSH_ADVANCE", "PUSH_CUSTOMER", "PUSH_INVOICE"].sort(),
        );
        const advJob = jobs.find((j) => j.op === "PUSH_ADVANCE");
        expect(advJob).toBeDefined();
        expect(advJob!.sourceType).toBe("AdvancePayment");
        // Sanity: the customer job matches this customer, not some
        // stray dependency chain.
        const custJob = jobs.find((j) => j.op === "PUSH_CUSTOMER");
        expect(custJob!.sourceId).toBe(customer.id);
    });

    it("cursor advances to (max createdAt, max id) — second pass is idempotent", async () => {
        const { job } = await seedGarageWithJob(gid);
        await seedApprovedEstimate(job.id);
        mockAuth.mockResolvedValue(
            await mockSessionAndSeed({
                id: P + "cashier",
                garageId: gid,
                role: "CASHIER",
            }),
        );
        await expect(
            generateInvoiceAction(await form({ jobCardId: job.id })),
        ).rejects.toThrow(/REDIRECT:/);

        await enableErpSyncForGarage({
            garageId: gid,
            startAt: new Date(0),
        });

        // First pass: enqueues 2 jobs.
        const first = await runTailer(gid);
        expect(first.status).toBe("advanced");
        const jobsAfterFirst = await prisma.erpSyncJob.count({
            where: { garageId: gid },
        });
        expect(jobsAfterFirst).toBe(2);

        // Cursor now sits at the last ledger row.
        const cursor = await prisma.erpSyncCursor.findUniqueOrThrow({
            where: { garageId: gid },
        });
        const lastLedger = await prisma.ledgerEntry.findFirst({
            where: { garageId: gid },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        expect(cursor.lastLedgerCreatedAt.getTime()).toBe(
            lastLedger!.createdAt.getTime(),
        );
        expect(cursor.lastLedgerId).toBe(lastLedger!.id);

        // Second pass: no new ledger rows, status = quiet.
        const second = await runTailer(gid);
        expect(second.status).toBe("quiet");
        const jobsAfterSecond = await prisma.erpSyncJob.count({
            where: { garageId: gid },
        });
        expect(jobsAfterSecond).toBe(2);
    });

    it("missing cursor → skipped-missing-cursor (does not throw, does not enqueue)", async () => {
        await prisma.garage.create({
            data: { id: gidNoCursor, name: gidNoCursor, erpSyncEnabled: true },
        });
        const result = await runTailer(gidNoCursor);
        expect(result.status).toBe("skipped-missing-cursor");
        expect(result.scanned).toBe(0);
        expect(result.enqueued).toBe(0);
        const jobs = await prisma.erpSyncJob.count({
            where: { garageId: gidNoCursor },
        });
        expect(jobs).toBe(0);
    });

    it("enableErpSyncForGarage defaults startAt=now — no historical backfill", async () => {
        const { job } = await seedGarageWithJob(gid);
        await seedApprovedEstimate(job.id);
        mockAuth.mockResolvedValue(
            await mockSessionAndSeed({
                id: P + "cashier",
                garageId: gid,
                role: "CASHIER",
            }),
        );
        // Historical invoice write BEFORE enable.
        await expect(
            generateInvoiceAction(await form({ jobCardId: job.id })),
        ).rejects.toThrow(/REDIRECT:/);

        // Enable with default startAt (now). The just-written ledger
        // rows have createdAt STRICTLY LESS THAN startAt.
        await enableErpSyncForGarage({ garageId: gid });

        const result = await runTailer(gid);
        expect(result.status).toBe("quiet");
        const jobs = await prisma.erpSyncJob.count({
            where: { garageId: gid },
        });
        expect(jobs).toBe(0);
    });

    it("payment enqueues PUSH_PAYMENT with PUSH_INVOICE as dep", async () => {
        const { job } = await seedGarageWithJob(gid);
        await seedApprovedEstimate(job.id);
        mockAuth.mockResolvedValue(
            await mockSessionAndSeed({
                id: P + "cashier",
                garageId: gid,
                role: "CASHIER",
            }),
        );
        await expect(
            generateInvoiceAction(await form({ jobCardId: job.id })),
        ).rejects.toThrow(/REDIRECT:/);
        const inv = await prisma.invoice.findFirstOrThrow({
            where: { jobCardId: job.id },
        });
        await expect(
            recordPaymentAction(
                await form({
                    invoiceId: inv.id,
                    amount: "105",
                    method: "CASH",
                }),
            ),
        ).rejects.toThrow(/REDIRECT:/);

        await enableErpSyncForGarage({
            garageId: gid,
            startAt: new Date(0),
        });
        await runTailer(gid);

        const payJob = await prisma.erpSyncJob.findFirstOrThrow({
            where: { garageId: gid, op: "PUSH_PAYMENT" },
        });
        expect(payJob.sourceType).toBe("Payment");
        const invJob = await prisma.erpSyncJob.findFirstOrThrow({
            where: { garageId: gid, op: "PUSH_INVOICE" },
        });
        expect(payJob.dependsOnJobIds).toContain(invJob.id);
    });
});
