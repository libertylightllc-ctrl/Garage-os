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
  isRecordableMethod,
  isQuoteIncrease,
  jobPartLineDescription,
  parseLineEditInput,
  type DraftLine,
  type LineKind,
} from "@/lib/billing";
import { sendWhatsApp, appUrl } from "@/lib/whatsapp";
import { signId } from "@/lib/tokens";
import { PRICING_ROLES, SEND_ROLES } from "@/lib/permissions";

async function customerForJob(jobCardId: string) {
  const j = await prisma.jobCard.findUnique({
    where: { id: jobCardId },
    include: { vehicle: { include: { customer: true } } },
  });
  return j?.vehicle.customer ?? null;
}

async function requireAnyRole(roles: string[]) {
  const session = await auth();
  if (!session?.user || !roles.includes(session.user.role)) throw new Error("Not authorized");
  return session.user;
}

async function jobInGarage(jobId: string, garageId: string) {
  const job = await prisma.jobCard.findFirst({ where: { id: jobId, garageId }, select: { id: true } });
  if (!job) throw new Error("Job not found in this garage");
  return job;
}

export async function createEstimateAction(formData: FormData) {
  const user = await requireAnyRole(PRICING_ROLES);
  const jobId = String(formData.get("jobId") ?? "");
  await jobInGarage(jobId, user.garageId);
  const est = await prisma.estimate.create({
    data: { jobCardId: jobId, subtotal: 0, vatAmount: 0, total: 0, status: "DRAFT" },
    select: { id: true },
  });
  revalidatePath("/cashier");
  revalidatePath(`/advisor/jobs/${jobId}`);
  redirect(`/estimates/${est.id}`);
}

async function recomputeEstimate(estimateId: string) {
  // Totals reflect only ACCEPTED lines — declined (customer-skipped) items don't count.
  const lines = await prisma.estimateLine.findMany({ where: { estimateId, declined: false } });
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
  const user = await requireAnyRole(PRICING_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const est = await ownedEstimate(estimateId, user.garageId);
  if (est.status !== "DRAFT") throw new Error("Estimate is not editable");

  // "DISCOUNT" is a convenience: stored as a FEE line with a negative amount.
  const rawKind = String(formData.get("kind") ?? "LABOR");
  const isDiscount = rawKind === "DISCOUNT";
  const kind = (isDiscount ? "FEE" : rawKind) as LineKind;
  const description =
    String(formData.get("description") ?? "").trim() || (isDiscount ? "Discount" : "Item");
  const qty = Math.max(0, Number(formData.get("qty") ?? 1));
  const priceAbs = Math.abs(Number(formData.get("unitPrice") ?? 0));
  const unitPrice = isDiscount ? -priceAbs : priceAbs;

  await prisma.estimateLine.create({
    data: { estimateId, kind, description, qty, unitPrice, lineTotal: lineTotal(qty, unitPrice) },
  });
  await recomputeEstimate(estimateId);
  revalidatePath(`/estimates/${estimateId}`);
}

// One-click itemise: turn a technician part (required/used) into a priced PART line,
// pre-filled with the catalog price when the part is catalog-linked.
export async function addLineFromPartAction(formData: FormData) {
  const user = await requireAnyRole(PRICING_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const jobPartId = String(formData.get("jobPartId") ?? "");
  const est = await ownedEstimate(estimateId, user.garageId);
  if (est.status !== "DRAFT") throw new Error("Estimate is not editable");

  const jp = await prisma.jobPart.findFirst({
    where: { id: jobPartId, jobCardId: est.jobCardId },
    include: { part: { select: { price: true } } },
  });
  if (!jp) throw new Error("Part not found on this job");

  const qty = Math.max(1, jp.qty);
  const unitPrice = jp.part ? Number(jp.part.price) : 0; // catalog price, else cashier sets it
  await prisma.estimateLine.create({
    data: {
      estimateId,
      kind: "PART",
      partId: jp.partId,
      description: jobPartLineDescription(jp.partNo, jp.description),
      qty,
      unitPrice,
      lineTotal: lineTotal(qty, unitPrice),
    },
  });
  await recomputeEstimate(estimateId);
  revalidatePath(`/estimates/${estimateId}`);
}

// Inline-edit a line's unit price (preserves the sign of discount lines).
export async function updateEstimateLinePriceAction(formData: FormData) {
  const user = await requireAnyRole(PRICING_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const lineId = String(formData.get("lineId") ?? "");
  const est = await ownedEstimate(estimateId, user.garageId);
  if (est.status !== "DRAFT") throw new Error("Estimate is not editable");

  const line = await prisma.estimateLine.findFirst({ where: { id: lineId, estimateId } });
  if (!line) throw new Error("Line not found");
  const priceAbs = Math.abs(Number(formData.get("unitPrice") ?? 0));
  const unitPrice = Number(line.unitPrice) < 0 ? -priceAbs : priceAbs;
  await prisma.estimateLine.update({
    where: { id: lineId },
    data: { unitPrice, lineTotal: lineTotal(Number(line.qty), unitPrice) },
  });
  await recomputeEstimate(estimateId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function toggleEstimateLineAction(formData: FormData) {
  const user = await requireAnyRole(PRICING_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const lineId = String(formData.get("lineId") ?? "");
  await ownedEstimate(estimateId, user.garageId);
  const line = await prisma.estimateLine.findFirst({ where: { id: lineId, estimateId } });
  if (line) {
    await prisma.estimateLine.update({
      where: { id: lineId },
      data: { declined: !line.declined },
    });
    await recomputeEstimate(estimateId);
  }
  revalidatePath(`/estimates/${estimateId}`);
}

export async function removeEstimateLineAction(formData: FormData) {
  const user = await requireAnyRole(PRICING_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const lineId = String(formData.get("lineId") ?? "");
  const est = await ownedEstimate(estimateId, user.garageId);
  // Lock once the estimate has left DRAFT — UI hides the button, but a
  // hand-crafted POST would otherwise still succeed and corrupt a sent
  // estimate's audit trail.
  if (est.status !== "DRAFT") throw new Error("Estimate is not editable");
  await prisma.estimateLine.deleteMany({ where: { id: lineId, estimateId } });
  await recomputeEstimate(estimateId);
  revalidatePath(`/estimates/${estimateId}`);
}

/**
 * Full inline edit of a line: kind + description + qty + unit price.
 * DISCOUNT is sugar for a FEE line with a negative amount — same convention
 * as addEstimateLineAction. Gated on DRAFT status (server-side enforcement
 * matches the UI gate).
 */
export async function updateEstimateLineAction(formData: FormData) {
  const user = await requireAnyRole(PRICING_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const lineId = String(formData.get("lineId") ?? "");
  const est = await ownedEstimate(estimateId, user.garageId);
  if (est.status !== "DRAFT") throw new Error("Estimate is not editable");

  const line = await prisma.estimateLine.findFirst({ where: { id: lineId, estimateId } });
  if (!line) throw new Error("Line not found");

  const parsed = parseLineEditInput({
    kind: formData.get("kind"),
    description: formData.get("description"),
    qty: formData.get("qty"),
    unitPrice: formData.get("unitPrice"),
  });
  if (!parsed.ok) throw new Error(`Invalid line edit: ${parsed.error}`);
  const { kind, description, qty, unitPrice } = parsed;

  await prisma.estimateLine.update({
    where: { id: lineId },
    data: { kind, description, qty, unitPrice, lineTotal: lineTotal(qty, unitPrice) },
  });
  await recomputeEstimate(estimateId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function setEstimateStatusAction(formData: FormData) {
  const user = await requireAnyRole(SEND_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const status = String(formData.get("status") ?? "") as "SENT" | "APPROVED" | "REJECTED";
  const est = await ownedEstimate(estimateId, user.garageId);

  if (status === "APPROVED") {
    // Record the approval (audit) and resume the job if it was paused for approval.
    await prisma.estimate.update({
      where: { id: est.id },
      data: { status, approvedAt: new Date(), approvedAmount: est.total },
    });
    await prisma.jobCard.update({
      where: { id: est.jobCardId },
      data: { status: "APPROVED", heldFrom: null, holdReason: null, holdNote: null },
    });
  } else if (status === "REJECTED") {
    await prisma.estimate.update({ where: { id: est.id }, data: { status } });
    await prisma.jobCard.update({ where: { id: est.jobCardId }, data: { status: "ESTIMATE" } });
  } else if (status === "SENT") {
    await prisma.estimate.update({
      where: { id: est.id },
      data: {
        status,
        // Time-tracking: end of the pricing window (used to render
        // 'Pricing: 12m' on every dashboard).
        sentAt: new Date(),
      },
    });
    // Send the customer the WhatsApp approval link (mock if no Meta token).
    const customer = await customerForJob(est.jobCardId);
    if (customer) {
      await sendWhatsApp({
        garageId: user.garageId,
        customerId: customer.id,
        waId: customer.waId ?? customer.phone,
        template: "estimate_approval",
        body: `Your estimate is ready. Review & approve: ${appUrl()}/c/estimate/${signId("estimate", est.id)}`,
      });
    }
    // Quote-approval gate: if this revised quote exceeds an already-approved total,
    // auto-pause the job to "waiting for approval" — no extra work until the customer approves.
    const prior = await prisma.estimate.aggregate({
      where: { jobCardId: est.jobCardId, status: "APPROVED", NOT: { id: est.id } },
      _max: { total: true },
    });
    const lastApproved = Number(prior._max.total ?? 0);
    if (isQuoteIncrease(Number(est.total), lastApproved)) {
      const job = await prisma.jobCard.findUnique({
        where: { id: est.jobCardId },
        select: { status: true },
      });
      if (job && job.status !== "ON_HOLD") {
        await prisma.jobCard.update({
          where: { id: est.jobCardId },
          data: { status: "ON_HOLD", heldFrom: job.status, holdReason: "AWAITING_APPROVAL" },
        });
      }
    }
  }
  revalidatePath(`/estimates/${estimateId}`);
  revalidatePath(`/advisor/jobs/${est.jobCardId}`);
}

export async function generateInvoiceAction(formData: FormData) {
  const user = await requireAnyRole(PRICING_ROLES);
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
          create: est.lines
            .filter((l) => !l.declined)
            .map((l) => ({
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

  // NOTE: Per spec Stage 8, the customer-facing WhatsApp send now happens
  // in a SEPARATE explicit step (sendInvoiceToCustomerAction below) — the
  // cashier reviews the invoice items first, then taps 'Send invoice to
  // customer'. generateInvoiceAction just creates the invoice row.

  redirect(`/invoices/${invoiceId}`);
}

/**
 * Stage 8 — Cashier taps 'Send invoice to customer' after reviewing items.
 * Stamps the JobCard.invoiceSentAt timestamp + records a 'would-send'
 * WhatsApp log entry (mock per build decision; real Meta send is a
 * separate task). Redirects to a confirmation screen so the cashier
 * knows the handoff happened.
 */
export async function sendInvoiceToCustomerAction(formData: FormData) {
  const user = await requireAnyRole(PRICING_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, garageId: user.garageId },
    select: { id: true, jobCardId: true, number: true, issuedAt: true },
  });
  if (!inv) throw new Error("Invoice not found in this garage");

  const customer = await customerForJob(inv.jobCardId);
  if (!customer) throw new Error("Customer not found for this invoice");

  // Stamp the send + flip the job to its invoice-sent state. We don't
  // change job.status (it's already INVOICED from generateInvoiceAction);
  // the friendly badge picks up AWAITING_PAYMENT from invoicePaidInFull.
  await prisma.jobCard.update({
    where: { id: inv.jobCardId },
    data: { invoiceSentAt: new Date() },
  });

  // MOCK send — log what we would have sent over WhatsApp. Real Meta wiring
  // happens in a follow-up task per the user's build decision.
  console.log(
    `[mock-whatsapp] would send invoice ${inv.number} to ${customer.waId ?? customer.phone} — ${appUrl()}/c/invoice/${signId("invoice", inv.id)}`,
  );

  revalidatePath("/cashier");
  revalidatePath("/advisor");
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath(`/advisor/jobs/${inv.jobCardId}`);
  redirect(`/invoices/${invoiceId}/sent`);
}

export async function recordPaymentAction(formData: FormData) {
  // Cashier or owner records payment (record-only: cash / card-POS).
  const user = await requireAnyRole(PRICING_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const amount = Math.max(0, Number(formData.get("amount") ?? 0));
  const method = String(formData.get("method") ?? "CASH");

  // Record-only: Cash / Card (POS). Online Link is not wired yet (Plan B / PSP).
  if (!isRecordableMethod(method)) {
    throw new Error("Online payment links aren’t available yet — use Cash or Card (POS).");
  }

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
  revalidatePath("/cashier");
}
