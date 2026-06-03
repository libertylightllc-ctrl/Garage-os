"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { paymentLedger } from "@/lib/billing";
import { recordInbound } from "@/lib/whatsapp";
import { verifyToken } from "@/lib/tokens";

// These are the customer's surface (reached via a WhatsApp link). No staff auth;
// authorization is the unguessable record id acting as a capability token.
// (Production: sign the token; here the cuid is sufficient for a pilot.)

async function logInbound(garageId: string, customerId: string, waId: string, body: string) {
  await recordInbound({ garageId, customerId, waId, waMessageId: `web-${randomUUID()}`, body });
}

export async function approveEstimatePublic(formData: FormData) {
  const id = verifyToken("estimate", String(formData.get("token") ?? ""));
  if (!id) return;
  const est = await prisma.estimate.findUnique({
    where: { id },
    include: { jobCard: { include: { vehicle: { include: { customer: true } } } } },
  });
  if (!est || est.status !== "SENT") return;
  await prisma.estimate.update({ where: { id }, data: { status: "APPROVED" } });
  await prisma.jobCard.update({ where: { id: est.jobCardId }, data: { status: "APPROVED" } });
  const c = est.jobCard.vehicle.customer;
  await logInbound(c.garageId, c.id, c.waId ?? c.phone, "APPROVE");
  revalidatePath(`/c/estimate/${id}`);
}

export async function rejectEstimatePublic(formData: FormData) {
  const id = verifyToken("estimate", String(formData.get("token") ?? ""));
  if (!id) return;
  const est = await prisma.estimate.findUnique({
    where: { id },
    include: { jobCard: { include: { vehicle: { include: { customer: true } } } } },
  });
  if (!est || est.status !== "SENT") return;
  await prisma.estimate.update({ where: { id }, data: { status: "REJECTED" } });
  await prisma.jobCard.update({ where: { id: est.jobCardId }, data: { status: "ESTIMATE" } });
  const c = est.jobCard.vehicle.customer;
  await logInbound(c.garageId, c.id, c.waId ?? c.phone, "REJECT");
  revalidatePath(`/c/estimate/${id}`);
}

export async function payInvoicePublic(formData: FormData) {
  const id = verifyToken("invoice", String(formData.get("token") ?? ""));
  if (!id) return;
  const inv = await prisma.invoice.findUnique({
    where: { id },
    include: { payments: true, jobCard: { include: { vehicle: { include: { customer: true } } } } },
  });
  if (!inv || inv.status === "PAID") return;

  const total = Number(inv.total);
  const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = Math.max(0, total - paid);
  if (balance <= 0) return;

  await prisma.$transaction(async (tx) => {
    await tx.payment.create({ data: { invoiceId: inv.id, amount: balance, method: "ONLINE_LINK" } });
    await tx.ledgerEntry.createMany({
      data: paymentLedger(balance).map((e) => ({
        garageId: inv.garageId,
        account: e.account,
        debit: e.debit,
        credit: e.credit,
        sourceType: "PAYMENT",
        sourceId: inv.id,
      })),
    });
    await tx.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });
  });

  const c = inv.jobCard.vehicle.customer;
  await logInbound(c.garageId, c.id, c.waId ?? c.phone, "PAID");
  revalidatePath(`/c/invoice/${id}`);
}
