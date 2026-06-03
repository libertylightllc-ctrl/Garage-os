"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  totalsFor,
  lineTotal,
  invoiceLedger,
  paymentLedger,
  vatStrategyFor,
  qrPlaceholder,
  type DraftLine,
  type LineKind,
} from "@/lib/billing";

async function requireRoleUser(role: "ADVISOR" | "ACCOUNTANT") {
  const session = await auth();
  if (!session?.user || session.user.role !== role) throw new Error("Not authorized");
  return session.user;
}

async function jobInGarage(jobId: string, garageId: string) {
  const job = await prisma.jobCard.findFirst({ where: { id: jobId, garageId }, select: { id: true } });
  if (!job) throw new Error("Job not found in this garage");
  return job;
}

export async function createEstimateAction(formData: FormData) {
  const user = await requireRoleUser("ADVISOR");
  const jobId = String(formData.get("jobId") ?? "");
  await jobInGarage(jobId, user.garageId);
  const est = await prisma.estimate.create({
    data: { jobCardId: jobId, subtotal: 0, vatAmount: 0, total: 0, status: "DRAFT" },
    select: { id: true },
  });
  revalidatePath(`/advisor/jobs/${jobId}`);
  redirect(`/advisor/estimates/${est.id}`);
}

async function recomputeEstimate(estimateId: string) {
  const lines = await prisma.estimateLine.findMany({ where: { estimateId } });
  const draft: DraftLine[] = lines.map((l) => ({
    kind: l.kind as LineKind,
    description: l.description,
    qty: Number(l.qty),
    unitPrice: Number(l.unitPrice),
  }));
  const t = totalsFor(draft);
  await prisma.estimate.update({
    where: { id: estimateId },
    data: { subtotal: t.subtotal, vatAmount: t.vatAmount, total: t.total },
  });
}

async function ownedEstimate(estimateId: string, garageId: string) {
  const est = await prisma.estimate.findFirst({
    where: { id: estimateId, jobCard: { garageId } },
    include: { jobCard: { select: { id: true, garageId: true } } },
  });
  if (!est) throw new Error("Estimate not found in this garage");
  return est;
}

export async function addEstimateLineAction(formData: FormData) {
  const user = await requireRoleUser("ADVISOR");
  const estimateId = String(formData.get("estimateId") ?? "");
  const est = await ownedEstimate(estimateId, user.garageId);
  if (est.status !== "DRAFT") throw new Error("Estimate is not editable");

  const kind = String(formData.get("kind") ?? "LABOR") as LineKind;
  const description = String(formData.get("description") ?? "").trim() || "Item";
  const qty = Math.max(0, Number(formData.get("qty") ?? 1));
  const unitPrice = Math.max(0, Number(formData.get("unitPrice") ?? 0));

  await prisma.estimateLine.create({
    data: { estimateId, kind, description, qty, unitPrice, lineTotal: lineTotal(qty, unitPrice) },
  });
  await recomputeEstimate(estimateId);
  revalidatePath(`/advisor/estimates/${estimateId}`);
}

export async function removeEstimateLineAction(formData: FormData) {
  const user = await requireRoleUser("ADVISOR");
  const estimateId = String(formData.get("estimateId") ?? "");
  const lineId = String(formData.get("lineId") ?? "");
  await ownedEstimate(estimateId, user.garageId);
  await prisma.estimateLine.deleteMany({ where: { id: lineId, estimateId } });
  await recomputeEstimate(estimateId);
  revalidatePath(`/advisor/estimates/${estimateId}`);
}

export async function setEstimateStatusAction(formData: FormData) {
  const user = await requireRoleUser("ADVISOR");
  const estimateId = String(formData.get("estimateId") ?? "");
  const status = String(formData.get("status") ?? "") as "SENT" | "APPROVED" | "REJECTED";
  const est = await ownedEstimate(estimateId, user.garageId);
  await prisma.estimate.update({ where: { id: est.id }, data: { status } });
  // Reflect on the job timeline: approval moves it forward; rejection sends back to ESTIMATE.
  if (status === "APPROVED") {
    await prisma.jobCard.update({ where: { id: est.jobCardId }, data: { status: "APPROVED" } });
  } else if (status === "REJECTED") {
    await prisma.jobCard.update({ where: { id: est.jobCardId }, data: { status: "ESTIMATE" } });
  }
  revalidatePath(`/advisor/estimates/${estimateId}`);
  revalidatePath(`/advisor/jobs/${est.jobCardId}`);
}

export async function generateInvoiceAction(formData: FormData) {
  const user = await requireRoleUser("ADVISOR");
  const estimateId = String(formData.get("estimateId") ?? "");
  const est = await prisma.estimate.findFirst({
    where: { id: estimateId, jobCard: { garageId: user.garageId } },
    include: { lines: true, invoice: true },
  });
  if (!est) throw new Error("Estimate not found");
  if (est.status !== "APPROVED") throw new Error("Estimate must be approved first");
  if (est.invoice) redirect(`/invoices/${est.invoice.id}`);

  const strategy = vatStrategyFor("UAE");
  const now = new Date();
  const dueDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const invoiceId = await prisma.$transaction(async (tx) => {
    const g = await tx.garage.update({
      where: { id: user.garageId },
      data: { invoiceSeq: { increment: 1 } },
      select: { invoiceSeq: true, name: true, trn: true },
    });
    const seq = g.invoiceSeq;

    const subtotal = Number(est.subtotal);
    const vatAmount = Number(est.vatAmount);
    const total = Number(est.total);

    const inv = await tx.invoice.create({
      data: {
        garageId: user.garageId,
        jobCardId: est.jobCardId,
        estimateId: est.id,
        number: seq,
        issuedAt: now,
        dueDate,
        subtotal,
        vatAmount,
        total,
        status: "SENT",
        clearanceStatus: strategy.clearanceStatus,
        qrPayload: qrPlaceholder({
          seller: g.name,
          trn: g.trn,
          total,
          vat: vatAmount,
          isoDate: now.toISOString(),
        }),
        lines: {
          create: est.lines.map((l) => ({
            kind: l.kind,
            description: l.description,
            qty: l.qty,
            unitPrice: l.unitPrice,
            lineTotal: l.lineTotal,
            vatRate: l.vatRate,
          })),
        },
      },
      select: { id: true },
    });

    // Zero-entry: auto-write the ledger rows for issuing the invoice.
    await tx.ledgerEntry.createMany({
      data: invoiceLedger(subtotal, vatAmount, total).map((e) => ({
        garageId: user.garageId,
        account: e.account,
        debit: e.debit,
        credit: e.credit,
        sourceType: "INVOICE",
        sourceId: inv.id,
      })),
    });

    await tx.jobCard.update({ where: { id: est.jobCardId }, data: { status: "INVOICED" } });
    return inv.id;
  });

  redirect(`/invoices/${invoiceId}`);
}

export async function recordPaymentAction(formData: FormData) {
  const user = await requireRoleUser("ACCOUNTANT");
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const amount = Math.max(0, Number(formData.get("amount") ?? 0));
  const method = String(formData.get("method") ?? "CASH");

  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, garageId: user.garageId },
    include: { payments: true },
  });
  if (!inv) throw new Error("Invoice not found");
  if (amount <= 0) throw new Error("Amount must be positive");

  await prisma.$transaction(async (tx) => {
    await tx.payment.create({ data: { invoiceId: inv.id, amount, method } });
    await tx.ledgerEntry.createMany({
      data: paymentLedger(amount).map((e) => ({
        garageId: user.garageId,
        account: e.account,
        debit: e.debit,
        credit: e.credit,
        sourceType: "PAYMENT",
        sourceId: inv.id,
      })),
    });
    const paidSoFar = inv.payments.reduce((s, p) => s + Number(p.amount), 0) + amount;
    if (paidSoFar >= Number(inv.total)) {
      await tx.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });
    }
  });

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/accountant");
}
