// Server-side loader: fetch every audit-relevant relation for a job
// + the garage's user directory, hand them to buildJobTimeline, and
// return the sorted events. Each job-view page calls this once.

import { prisma } from "@/lib/prisma";
import { buildJobTimeline, type TimelineEvent } from "@/lib/job-timeline";

export async function loadJobTimeline(
    jobId: string,
    garageId: string,
): Promise<TimelineEvent[]> {
    const [job, steps, finding, partRequests, estimates, invoices, advancePayments, users] =
        await Promise.all([
            prisma.jobCard.findFirst({
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
                    moulkiaConsentAt: true,
                },
            }),
            prisma.jobStep.findMany({
                where: { jobCardId: jobId },
                select: { type: true, createdAt: true, techId: true, transcript: true },
                orderBy: { createdAt: "asc" },
            }),
            prisma.jobFinding.findFirst({
                where: { jobCardId: jobId },
                select: { submittedAt: true, techId: true },
            }),
            prisma.partRequest.findMany({
                where: { jobCardId: jobId },
                select: { description: true, qty: true, createdAt: true, requestedById: true },
                orderBy: { createdAt: "asc" },
            }),
            prisma.estimate.findMany({
                where: { jobCardId: jobId },
                select: { createdAt: true, sentAt: true, approvedAt: true, status: true },
                orderBy: { createdAt: "asc" },
            }),
            prisma.invoice.findMany({
                where: { jobCardId: jobId },
                select: {
                    createdAt: true,
                    payments: { select: { amount: true, paidAt: true } },
                },
                orderBy: { createdAt: "asc" },
            }),
            prisma.advancePayment.findMany({
                where: { jobCardId: jobId },
                select: { amount: true, receivedAt: true },
                orderBy: { receivedAt: "asc" },
            }),
            prisma.user.findMany({
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
