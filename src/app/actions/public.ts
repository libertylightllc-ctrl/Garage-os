"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { totalsFor, type LineKind } from "@/lib/billing";
import { recordInbound } from "@/lib/whatsapp";
import { resolveDocumentToken } from "@/lib/document-tokens";
import { revalidateEstimateStaffSurfaces } from "@/lib/revalidate-estimate-surfaces";

// These are the customer's surface (reached via a WhatsApp link). No staff auth;
// authorization is the unguessable record id acting as a capability token.
// (Production: sign the token; here the cuid is sufficient for a pilot.)

async function logInbound(garageId: string, customerId: string, waId: string, body: string) {
  await recordInbound({ garageId, customerId, waId, waMessageId: `web-${randomUUID()}`, body });
}

export async function approveEstimatePublic(formData: FormData) {
  const id = await resolveDocumentToken("estimate", String(formData.get("token") ?? ""));
  if (!id) return;
  const est = await prisma.estimate.findUnique({
    where: { id },
    include: { jobCard: { include: { vehicle: { include: { customer: true } } } } },
  });
  if (!est || est.status !== "SENT") return;
  // Transaction — approval flips TWO rows (estimate + jobCard). A crash
  // between them used to leave a half-approved state (customer sees
  // APPROVED, advisor sees the job still paused). AR 2026-08-18.
  await prisma.$transaction([
    prisma.estimate.update({
      where: { id },
      data: { status: "APPROVED", approvedAt: new Date(), approvedAmount: est.total },
    }),
    prisma.jobCard.update({
      where: { id: est.jobCardId },
      data: { status: "APPROVED", heldFrom: null, holdReason: null, holdNote: null },
    }),
  ]);
  const c = est.jobCard.vehicle.customer;
  await logInbound(c.garageId, c.id, c.waId ?? c.phone, "APPROVE");
  revalidatePath(`/c/estimate/${id}`);
  // /cashier is now part of the central set — see
  // src/lib/revalidate-estimate-surfaces.ts.
  revalidateEstimateStaffSurfaces(est.jobCardId, id);
}

export async function rejectEstimatePublic(formData: FormData) {
  const id = await resolveDocumentToken("estimate", String(formData.get("token") ?? ""));
  if (!id) return;
  const est = await prisma.estimate.findUnique({
    where: { id },
    include: { jobCard: { include: { vehicle: { include: { customer: true } } } } },
  });
  if (!est || est.status !== "SENT") return;
  // Same transactional shape + full revalidation as approve — rejection
  // is exactly as urgent to surface to the advisor (wasted work if
  // they start on a rejected estimate). AR 2026-08-18.
  await prisma.$transaction([
    prisma.estimate.update({ where: { id }, data: { status: "REJECTED" } }),
    prisma.jobCard.update({ where: { id: est.jobCardId }, data: { status: "ESTIMATE" } }),
  ]);
  const c = est.jobCard.vehicle.customer;
  await logInbound(c.garageId, c.id, c.waId ?? c.phone, "REJECT");
  revalidatePath(`/c/estimate/${id}`);
  revalidateEstimateStaffSurfaces(est.jobCardId, id);
}

// Customer skips/restores a line on their estimate (while it's awaiting their decision).
export async function toggleLinePublic(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const estId = await resolveDocumentToken("estimate", token);
  if (!estId) return;
  const lineId = String(formData.get("lineId") ?? "");

  // Pull jobCardId so the staff-side revalidation reaches the right
  // job detail route. AR 2026-08-18.
  const est = await prisma.estimate.findUnique({
    where: { id: estId },
    select: { id: true, status: true, jobCardId: true },
  });
  if (!est || est.status !== "SENT") return;
  const line = await prisma.estimateLine.findFirst({ where: { id: lineId, estimateId: estId } });
  if (!line) return;

  // Transaction — the line toggle + estimate totals must land together.
  // Interactive form so the totals recompute reads the just-flipped
  // line inside the same tx (avoids a read-before-write race if a
  // concurrent toggle lands between our two operations). AR 2026-08-18.
  await prisma.$transaction(async (tx) => {
    await tx.estimateLine.update({
      where: { id: lineId },
      data: { declined: !line.declined },
    });
    const lines = await tx.estimateLine.findMany({
      where: { estimateId: estId, declined: false },
    });
    const t = totalsFor(
      lines.map((l) => ({
        kind: l.kind as LineKind,
        description: l.description,
        qty: Number(l.qty),
        unitPrice: Number(l.unitPrice),
      })),
    );
    await tx.estimate.update({
      where: { id: estId },
      data: { subtotal: t.subtotal, vatAmount: t.vatAmount, total: t.total },
    });
  });
  revalidatePath(`/c/estimate/${token}`);
  // Staff surfaces that render the same line/total data: the estimate
  // edit page (both the line list AND the totals summary) and the job
  // detail (estimate row's total is rendered inline). The advisor
  // dashboard doesn't show per-line detail, so no /advisor ping needed.
  revalidatePath(`/estimates/${estId}`);
  revalidatePath(`/advisor/jobs/${est.jobCardId}`);
}
// NOTE: customers do NOT pay through the app. The garage takes payment on its own
// cash/POS; staff record it via recordPaymentAction. (No payInvoicePublic.)
