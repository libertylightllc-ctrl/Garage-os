// Server-side loader: fetch every audit-relevant relation for a job
// + the garage's user directory, hand them to buildJobTimeline, and
// return the sorted events. Each job-view page calls this once.
//
// Optional `client` parameter (AR 2026-08-22) — the caller can pass a
// Prisma transaction client so the timeline's estimate/invoice reads
// share a snapshot with the page's OTHER reads of the same rows.
// Without this, the page's main jobCard query and this loader's
// estimate.findMany can straddle a mid-page commit (customer approve
// lands in the DB after the main query, before the timeline query),
// producing the state that surfaced on smoke #82: estimate row reads
// SENT while the timeline reads "approved by customer". See
// src/app/advisor/jobs/[id]/page.tsx for the wrapping transaction.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { buildJobTimeline, type TimelineEvent } from "@/lib/job-timeline";

export async function loadJobTimeline(
    jobId: string,
    garageId: string,
    client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<TimelineEvent[]> {
    const [job, steps, finding, partRequests, estimates, invoices, advancePayments, users] =
        await Promise.all([
            client.jobCard.findFirst({
                where: { id: jobId, garageId },
                select: {
                    createdAt: true,
                    advisorId: true,
                    claimedAt: true,
                    claimedById: true,
                    sentForEstimateAt: true,
                    sentForReestimateAt: true,
                    workCompletedAt: true,
                    qcAt: true,
                    qcById: true,
                    deliveredAt: true,
                    deliveredById: true,
                    deliveryConfirmedAt: true,
                    invoiceSentAt: true,
                    invoiceDeliveredAt: true,
                    moulkiaConsentAt: true,
                    // Cancellation audit — see prisma/migrations/
                    // 20260829000000_jobcard_cancelled_audit and
                    // job-timeline.ts kindKey "tlJobCancelled".
                    cancelledAt: true,
                    cancelledByUserId: true,
                    cancelReason: true,
                    // Hold audit — see prisma/migrations/
                    // 20260829010000_jobcard_held_audit and
                    // job-timeline.ts kindKey "tlJobHeld". holdReason
                    // + holdNote already exist; the two new columns
                    // are heldAt + heldByUserId.
                    heldAt: true,
                    heldByUserId: true,
                    holdReason: true,
                    holdNote: true,
                },
            }),
            client.jobStep.findMany({
                where: { jobCardId: jobId },
                select: { type: true, createdAt: true, techId: true, transcript: true },
                orderBy: { createdAt: "asc" },
            }),
            client.jobFinding.findFirst({
                where: { jobCardId: jobId },
                select: { submittedAt: true, techId: true },
            }),
            client.partRequest.findMany({
                where: { jobCardId: jobId },
                select: { description: true, qty: true, createdAt: true, requestedById: true },
                orderBy: { createdAt: "asc" },
            }),
            client.estimate.findMany({
                where: { jobCardId: jobId },
                select: { createdAt: true, sentAt: true, deliveredAt: true, approvedAt: true, status: true },
                orderBy: { createdAt: "asc" },
            }),
            client.invoice.findMany({
                where: { jobCardId: jobId },
                select: {
                    createdAt: true,
                    payments: { select: { amount: true, paidAt: true } },
                },
                orderBy: { createdAt: "asc" },
            }),
            client.advancePayment.findMany({
                where: { jobCardId: jobId },
                select: { amount: true, receivedAt: true },
                orderBy: { receivedAt: "asc" },
            }),
            client.user.findMany({
                where: { garageId },
                select: { id: true, name: true, role: true },
            }),
        ]);

    if (!job) return [];

    const userDir: Record<string, { name: string; role: string }> = {};
    for (const u of users) userDir[u.id] = { name: u.name, role: u.role };

    // Flatten payment rows from every invoice — invoice.createdAt
    // itself is the "issued" event; payments roll up separately.
    const payments = invoices.flatMap((i) =>
        i.payments.map((p) => ({ amount: Number(p.amount), paidAt: p.paidAt })),
    );

    return buildJobTimeline({
        job,
        steps,
        finding,
        partRequests,
        estimates: estimates.map((e) => ({
            createdAt: e.createdAt,
            sentAt: e.sentAt,
            deliveredAt: e.deliveredAt,
            approvedAt: e.approvedAt,
            status: e.status,
        })),
        invoices: invoices.map((i) => ({ createdAt: i.createdAt })),
        payments,
        advancePayments: advancePayments.map((a) => ({
            amount: Number(a.amount),
            receivedAt: a.receivedAt,
        })),
        users: userDir,
    });
}
