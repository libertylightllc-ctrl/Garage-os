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
  advanceLedger,
  advanceMigrationLedger,
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
import { buildWaMeUrl, normalizeToE164 } from "@/lib/wa";
import { invoiceMessage } from "@/lib/po-message";
import { logInvoiceSend } from "@/lib/invoice-send-log";
import { ESTIMATE_CREATE_ROLES, INVOICE_ROLES, SEND_ROLES } from "@/lib/permissions";
import { requireAnyRole } from "@/lib/action-guards";

// Defense-in-depth: even though every caller passes a jobCardId that's
// already been garage-verified (via ownedEstimate / ownedInvoice / the
// outer SEND_ROLES auth), this helper also scopes on garageId so a
// future refactor can't accidentally remove the upstream check and
// open a cross-garage leak. findFirst (not findUnique) because we no
// longer have a single-unique key.
async function customerForJob(jobCardId: string, garageId: string) {
  const j = await prisma.jobCard.findFirst({
    where: { id: jobCardId, garageId },
    include: { vehicle: { include: { customer: true } } },
  });
  return j?.vehicle.customer ?? null;
}


async function jobInGarage(jobId: string, garageId: string) {
  const job = await prisma.jobCard.findFirst({ where: { id: jobId, garageId }, select: { id: true } });
  if (!job) throw new Error("Job not found in this garage");
  return job;
}

export async function createEstimateAction(formData: FormData) {
  const user = await requireAnyRole(ESTIMATE_CREATE_ROLES);
  const jobId = String(formData.get("jobId") ?? "");
  await jobInGarage(jobId, user.garageId);

  // Idempotency: if a DRAFT estimate already exists on this job, route
  // straight to it instead of creating a sibling. Defends against the
  // double-click race we saw in prod where the cashier tapped "Set
  // price" twice within seconds and ended up with a stale empty DRAFT
  // alongside a priced one. We pick the OLDEST DRAFT so resuming after
  // a Vercel cold-start retry lands on the cashier's actual work, not
  // a brand-new blank.
  const existingDraft = await prisma.estimate.findFirst({
    where: { jobCardId: jobId, status: "DRAFT" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existingDraft) {
    redirect(`/estimates/${existingDraft.id}`);
  }

  // Revision branch — if the job's most recent estimate is REJECTED,
  // clone its line items into the new DRAFT so the cashier opens onto
  // the original prices to edit instead of a blank canvas with AED
  // 0.00 totals. The REJECTED row is NEVER mutated; it stays in place
  // as audit history. The cashier can edit / add / remove on the
  // fresh DRAFT, which becomes the active estimate on the job
  // (jobs.estimates orderBy createdAt desc puts the DRAFT first, so
  // dashboard renders + the Estimate page both pick it up
  // automatically).
  //
  // For a fresh job with no prior estimate, this branch is skipped
  // and we land on the original blank-DRAFT behaviour.
  const lastEstimate = await prisma.estimate.findFirst({
    where: { jobCardId: jobId },
    orderBy: { createdAt: "desc" },
    include: { lines: { orderBy: { createdAt: "asc" } } },
  });
  const clonedFromRejection = lastEstimate?.status === "REJECTED";

  const est = await prisma.$transaction(async (tx) => {
    const created = await tx.estimate.create({
      data: {
        jobCardId: jobId,
        // Totals on the new DRAFT — copy from the rejected row when we
        // have one, then recomputeEstimate later confirms the math.
        // For a fresh estimate, start at 0 as before.
        subtotal: clonedFromRejection ? lastEstimate!.subtotal : 0,
        vatAmount: clonedFromRejection ? lastEstimate!.vatAmount : 0,
        total: clonedFromRejection ? lastEstimate!.total : 0,
        status: "DRAFT",
        // Lines are cloned via nested-create so we never need a second
        // round-trip per row. partId/declined preserved verbatim so the
        // cashier sees the original mix (incl. customer-declined items
        // which they can re-include or keep declined).
        ...(clonedFromRejection
          ? {
              lines: {
                create: lastEstimate!.lines.map((l) => ({
                  kind: l.kind,
                  partId: l.partId,
                  description: l.description,
                  qty: l.qty,
                  unitPrice: l.unitPrice,
                  lineTotal: l.lineTotal,
                  vatRate: l.vatRate,
                  declined: l.declined,
                })),
              },
            }
          : {}),
      },
      select: { id: true },
    });
    return created;
  });

  // Defensive recompute — covers the edge case where the cloned
  // rejected row had drifted totals (e.g. a manual SQL edit). For a
  // fresh estimate it's a no-op (no lines yet).
  if (clonedFromRejection) {
    await recomputeEstimate(est.id);
  }

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
  const user = await requireAnyRole(ESTIMATE_CREATE_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const est = await ownedEstimate(estimateId, user.garageId);
  if (est.status !== "DRAFT") throw new Error("Estimate is not editable");

  // 3b — OPTIONAL catalog link. If the advisor picked a part, it must belong
  // to this garage; the line then stores partId so it "knows" which real part
  // it is. Link + display only — stock is NOT moved here. No pick → free-text
  // line, byte-identical to before.
  const partIdRaw = String(formData.get("partId") ?? "").trim();
  const linkedPart = partIdRaw
    ? await prisma.part.findFirst({
        where: { id: partIdRaw, garageId: user.garageId },
        select: { id: true, name: true, sku: true },
      })
    : null;
  if (partIdRaw && !linkedPart) throw new Error("Part not found in this garage");

  // "DISCOUNT" is a convenience: stored as a FEE line with a negative amount.
  const rawKind = String(formData.get("kind") ?? "LABOR");
  const isDiscount = rawKind === "DISCOUNT" && !linkedPart;
  // A catalog-linked line is by definition a PART line.
  const kind = (linkedPart ? "PART" : isDiscount ? "FEE" : rawKind) as LineKind;
  // PART lines no longer embed "(Make Model)" in the snapshot — Make /
  // Model / Year live in their own table columns at every display
  // surface now. The description is exactly what the cashier typed.
  const description =
    String(formData.get("description") ?? "").trim() ||
    (linkedPart ? `${linkedPart.name} (${linkedPart.sku})` : isDiscount ? "Discount" : "Item");
  const qty = Math.max(0, Number(formData.get("qty") ?? 1));
  const priceAbs = Math.abs(Number(formData.get("unitPrice") ?? 0));
  const unitPrice = isDiscount ? -priceAbs : priceAbs;

  await prisma.estimateLine.create({
    data: {
      estimateId,
      kind,
      partId: linkedPart?.id ?? null,
      description,
      qty,
      unitPrice,
      lineTotal: lineTotal(qty, unitPrice),
    },
  });
  await recomputeEstimate(estimateId);
  revalidatePath(`/estimates/${estimateId}`);
}

// One-click itemise: turn a technician part (required/used) into a priced PART line,
// pre-filled with the catalog price when the part is catalog-linked.
export async function addLineFromPartAction(formData: FormData) {
  const user = await requireAnyRole(ESTIMATE_CREATE_ROLES);
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
  const user = await requireAnyRole(ESTIMATE_CREATE_ROLES);
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
  const user = await requireAnyRole(ESTIMATE_CREATE_ROLES);
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
  const user = await requireAnyRole(ESTIMATE_CREATE_ROLES);
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
  const user = await requireAnyRole(ESTIMATE_CREATE_ROLES);
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
    // Re-estimate cycle: if the job was at EXTRA_WORK_AWAITING_APPROVAL and
    // the customer rejected the new estimate, fall back to APPROVED so the
    // tech keeps doing the originally approved work. For first-time
    // rejection (status=ESTIMATE), the existing 'back to ESTIMATE' loop
    // lets the cashier re-price.
    // Defense-in-depth: scope by user.garageId even though est.jobCardId
    // was already proven to belong to this garage via ownedEstimate above.
    const job = await prisma.jobCard.findFirst({
      where: { id: est.jobCardId, garageId: user.garageId },
      select: { status: true },
    });
    const nextStatus = job?.status === "EXTRA_WORK_AWAITING_APPROVAL" ? "APPROVED" : "ESTIMATE";
    await prisma.jobCard.update({
      where: { id: est.jobCardId },
      data: { status: nextStatus },
    });
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
    const customer = await customerForJob(est.jobCardId, user.garageId);
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
      // Defense-in-depth: scope by user.garageId; est was already verified
      // via ownedEstimate at the top of the action.
      const job = await prisma.jobCard.findFirst({
        where: { id: est.jobCardId, garageId: user.garageId },
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
  const user = await requireAnyRole(INVOICE_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  // Locate the clicked estimate just for jobCardId + invoice-exists check;
  // we then fan out and pull EVERY approved estimate for the same job so
  // the invoice merges original work + extras into a single document.
  // Re-estimate cycles create a second Estimate row at extras time, and
  // until now we only billed one of them. Spec: 'final invoice must
  // include ALL work in ONE invoice.'
  const clicked = await prisma.estimate.findFirst({
    where: { id: estimateId, jobCard: { garageId: user.garageId } },
    select: { id: true, status: true, jobCardId: true },
  });
  if (!clicked) throw new Error("Estimate not found");
  if (clicked.status !== "APPROVED") throw new Error("Estimate must be approved first");

  // Pull all approved estimates for this job, oldest first. The earliest
  // one becomes the 'primary' for the unique Invoice.estimateId link
  // when we create the invoice. If ANY of these already has an invoice
  // attached (Invoice.estimateId @unique), there's already an invoice
  // row for the job — we either top it up (below) or redirect.
  const approvedEstimates = await prisma.estimate.findMany({
    where: { jobCardId: clicked.jobCardId, status: "APPROVED" },
    include: { lines: true, invoice: { select: { id: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (approvedEstimates.length === 0) {
    throw new Error("No approved estimates to bill");
  }

  // Merge all non-declined lines across estimates. Order: original
  // estimate's lines first, then each subsequent re-estimate's lines
  // appended — preserves the natural reading order on the invoice.
  const mergedLines = approvedEstimates.flatMap((e) =>
    e.lines.filter((l) => !l.declined),
  );

  // ── Top-up path ───────────────────────────────────────────────────
  // If an invoice already exists for this job — typically because the
  // OLD pre-merge code generated one with only the clicked estimate's
  // lines — and it hasn't been sent yet, ADD any missing approved-
  // estimate lines to it rather than just redirecting. 'Missing' is
  // determined by a stable signature (description + qty + unitPrice)
  // so we don't re-add lines the cashier already kept and don't trip
  // on a description rename if everything else matches.
  // If the invoice was already sent (lines are locked) we still
  // redirect — mutating a sent invoice would break the audit trail
  // and the customer's existing copy.
  const existingInvoiceEstimate = approvedEstimates.find((e) => e.invoice);
  if (existingInvoiceEstimate) {
    const existingInvoiceId = existingInvoiceEstimate.invoice!.id;
    const existingInvoice = await prisma.invoice.findFirst({
      where: { id: existingInvoiceId },
      include: {
        lines: true,
        jobCard: { select: { invoiceDeliveredAt: true } },
      },
    });
    if (existingInvoice) {
      // Delivered → don't touch (2026-08-10 timestamp split — see
      // ownedEditableInvoice above for the reasoning). Handed-off-
      // only invoices are still safe to top up.
      if (existingInvoice.jobCard.invoiceDeliveredAt) {
        redirect(`/invoices/${existingInvoiceId}`);
      }
      const sig = (l: { description: string; qty: unknown; unitPrice: unknown }) =>
        `${l.description.trim().toLowerCase()}|${Number(l.qty)}|${Number(l.unitPrice)}`;
      const haveSigs = new Set(existingInvoice.lines.map(sig));
      const missing = mergedLines.filter((l) => !haveSigs.has(sig(l)));
      if (missing.length === 0) {
        // Invoice already complete vs. the approved estimates — nothing to do.
        redirect(`/invoices/${existingInvoiceId}`);
      }
      // Add the missing lines + recompute totals + replace ledger rows.
      await prisma.invoiceLine.createMany({
        data: missing.map((l) => ({
          invoiceId: existingInvoiceId,
          kind: l.kind,
          description: l.description,
          qty: l.qty,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          vatRate: l.vatRate,
        })),
      });
      await recomputeInvoice(existingInvoiceId, user.garageId);
      revalidatePath(`/invoices/${existingInvoiceId}`);
      revalidatePath("/cashier");
      redirect(`/invoices/${existingInvoiceId}`);
    }
  }
  // ── End top-up path ──────────────────────────────────────────────

  // Compute totals from the merged set (don't sum precomputed estimate
  // totals — those may include declined lines or drift if anyone touched
  // a line between approval and invoicing).
  const draftLines: DraftLine[] = mergedLines.map((l) => ({
    kind: l.kind as LineKind,
    description: l.description,
    qty: Number(l.qty),
    unitPrice: Number(l.unitPrice),
  }));
  const t = totalsFor(draftLines);
  const subtotal = t.subtotal;
  const vatAmount = t.vatAmount;
  const total = t.total;

  const strategy = vatStrategyFor("UAE");
  const now = new Date();
  const dueDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const primaryEstimateId = approvedEstimates[0].id;

  const invoiceId = await prisma.$transaction(async (tx) => {
    const g = await tx.garage.update({
      where: { id: user.garageId },
      data: { invoiceSeq: { increment: 1 } },
      select: { invoiceSeq: true, name: true, trn: true },
    });
    const seq = g.invoiceSeq;

    // Snapshot the customer's TRN at invoice-issue time. FTA rule: the
    // TRN printed on a tax invoice is what applied when it was issued;
    // if the customer's live TRN changes later (mis-typed, updated to
    // a new registration), historical invoices must not silently
    // rewrite. Invoice.customerTrn is that snapshot; renders prefer it
    // over the live customer.trn. Column has existed on Invoice since
    // 0_init — this is the first writer.
    const jobForCustomer = await tx.jobCard.findUnique({
      where: { id: clicked.jobCardId },
      select: { vehicle: { select: { customer: { select: { trn: true } } } } },
    });
    const customerTrnSnapshot = jobForCustomer?.vehicle.customer.trn ?? null;

    const inv = await tx.invoice.create({
      data: {
        garageId: user.garageId,
        jobCardId: clicked.jobCardId,
        // Single Invoice.estimateId stays @unique in the schema; we link
        // to the OLDEST approved estimate as the canonical primary.
        // Subsequent estimates' lines are still represented — they're
        // just inlined in invoice.lines rather than linked by FK.
        estimateId: primaryEstimateId,
        number: seq,
        // Frozen at issue — never rewritten by a later customer.trn edit.
        customerTrn: customerTrnSnapshot,
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
          create: mergedLines.map((l) => ({
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

    // ── Slice 6b: migrate advance payments onto the new invoice ──
    // Any AdvancePayment rows recorded against this job (after estimate
    // approval, before TECH_COMPLETE) get pulled in now. For each:
    //   1. Create a Payment row tied to the new invoice (the amount is
    //      what counts on the invoice ledger — method/receivedAt are
    //      preserved as the audit record on the AdvancePayment side).
    //   2. Write advanceMigrationLedger (DR Customer Deposits / CR AR).
    //      Cash was already DR'd at advance time — we don't double-count.
    //   3. Stamp migratedAt + paymentId on the AdvancePayment so the
    //      same row can never be migrated twice.
    // If sum of migrated advances >= total, flip the invoice to PAID
    // right away (status === PAID is what drives the receipt UI; the
    // ledger entries make this a real settled-AR position, not a flag).
    const advances = await tx.advancePayment.findMany({
      where: { jobCardId: clicked.jobCardId, migratedAt: null },
      orderBy: { receivedAt: "asc" },
    });
    let migratedSum = 0;
    for (const a of advances) {
      const amt = Number(a.amount);
      const payment = await tx.payment.create({
        data: {
          invoiceId: inv.id,
          amount: amt,
          method: a.method,
          paidAt: a.receivedAt,
        },
        select: { id: true },
      });
      await tx.ledgerEntry.createMany({
        data: advanceMigrationLedger(amt).map((e) => ({
          garageId: user.garageId,
          account: e.account,
          debit: e.debit,
          credit: e.credit,
          sourceType: "ADVANCE_MIGRATION",
          sourceId: a.id,
        })),
      });
      await tx.advancePayment.update({
        where: { id: a.id },
        data: { migratedAt: new Date(), paymentId: payment.id },
      });
      migratedSum += amt;
    }
    if (migratedSum >= total) {
      await tx.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });
    }

    await tx.jobCard.update({ where: { id: clicked.jobCardId }, data: { status: "INVOICED" } });
    return inv.id;
  });

  // NOTE: Per spec Stage 8, the customer-facing WhatsApp send now happens
  // in a SEPARATE explicit step (sendInvoiceToCustomerAction below) — the
  // cashier reviews the merged invoice items + edits anything that needs
  // adjustment, then taps 'Send invoice to customer'.
  // generateInvoiceAction just creates the invoice row with all lines
  // pre-populated from every approved estimate.

  redirect(`/invoices/${invoiceId}`);
}

// ────────────────────────────────────────────────────────────────
// Invoice line edits — let the cashier add/edit/remove items on
// the merged draft invoice BEFORE the WhatsApp send goes out.
// Per spec: 'Cashier must be able to edit the entire invoice…full
// control.'  All three actions share two invariants:
//   1. The invoice must belong to the caller's garage.
//   2. The invoice must NOT have been sent yet (jobCard.invoiceSentAt
//      is null). After send, line edits would silently rewrite a
//      document the customer already has — and break ZATCA / audit
//      trail rules. UI hides controls past that point; this is the
//      server-side enforcement.
// After every mutation we recompute totals + replace the ledger
// rows for this invoice so accounting stays balanced.
// ────────────────────────────────────────────────────────────────

async function ownedEditableInvoice(invoiceId: string, garageId: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, garageId },
    include: { jobCard: { select: { invoiceDeliveredAt: true } } },
  });
  if (!inv) throw new Error("Invoice not found in this garage");
  // Lock on DELIVERED, not handed-off (2026-08-10 timestamp split).
  // The wa.me hand-off doesn't guarantee the customer received
  // anything — the operator still has to press Send inside their
  // WhatsApp. Locking on handed-off froze operators out of fixing
  // legitimate mistakes (missed labour, wrong plate) even before
  // the customer saw anything. Once the Meta Cloud API delivery
  // webhook lands, invoiceDeliveredAt becomes a real signal and
  // this guard becomes a real lock; until then it's effectively
  // permissive, which matches the wa.me shape's real capabilities.
  if (inv.jobCard.invoiceDeliveredAt) {
    throw new Error(
      "Invoice already delivered to customer — use Void & correct to issue a replacement.",
    );
  }
  return inv;
}

async function recomputeInvoice(invoiceId: string, garageId: string) {
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
  const draft: DraftLine[] = lines.map((l) => ({
    kind: l.kind as LineKind,
    description: l.description,
    qty: Number(l.qty),
    unitPrice: Number(l.unitPrice),
  }));
  const t = totalsFor(draft);
  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { subtotal: t.subtotal, vatAmount: t.vatAmount, total: t.total },
    });
    // Replace the auto-posted ledger rows so the books still tie out
    // to the new total. Payments use sourceType='PAYMENT' so they're
    // not touched. (Edits are only legal before send → before any
    // payment → no risk of trashing payment trails.)
    await tx.ledgerEntry.deleteMany({
      where: { sourceType: "INVOICE", sourceId: invoiceId },
    });
    await tx.ledgerEntry.createMany({
      data: invoiceLedger(t.subtotal, t.vatAmount, t.total).map((e) => ({
        garageId,
        account: e.account,
        debit: e.debit,
        credit: e.credit,
        sourceType: "INVOICE",
        sourceId: invoiceId,
      })),
    });
  });
}

export async function addInvoiceLineAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  await ownedEditableInvoice(invoiceId, user.garageId);

  // Same DISCOUNT convention as addEstimateLineAction — sugar for a
  // FEE line with a negative amount, keeps the cashier flow
  // consistent across estimate-edit and invoice-edit screens.
  const rawKind = String(formData.get("kind") ?? "LABOR");
  const isDiscount = rawKind === "DISCOUNT";
  const kind = (isDiscount ? "FEE" : rawKind) as LineKind;
  const description =
    String(formData.get("description") ?? "").trim() || (isDiscount ? "Discount" : "Item");
  const qty = Math.max(0, Number(formData.get("qty") ?? 1));
  const priceAbs = Math.abs(Number(formData.get("unitPrice") ?? 0));
  const unitPrice = isDiscount ? -priceAbs : priceAbs;

  await prisma.invoiceLine.create({
    data: {
      invoiceId,
      kind,
      description,
      qty,
      unitPrice,
      lineTotal: lineTotal(qty, unitPrice),
    },
  });
  await recomputeInvoice(invoiceId, user.garageId);
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/cashier");
}

export async function updateInvoiceLineAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const lineId = String(formData.get("lineId") ?? "");
  await ownedEditableInvoice(invoiceId, user.garageId);

  const line = await prisma.invoiceLine.findFirst({ where: { id: lineId, invoiceId } });
  if (!line) throw new Error("Line not found on this invoice");

  const parsed = parseLineEditInput({
    kind: formData.get("kind"),
    description: formData.get("description"),
    qty: formData.get("qty"),
    unitPrice: formData.get("unitPrice"),
  });
  if (!parsed.ok) throw new Error(`Invalid line edit: ${parsed.error}`);
  const { kind, description, qty, unitPrice } = parsed;

  await prisma.invoiceLine.update({
    where: { id: lineId },
    data: { kind, description, qty, unitPrice, lineTotal: lineTotal(qty, unitPrice) },
  });
  await recomputeInvoice(invoiceId, user.garageId);
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/cashier");
}

export async function removeInvoiceLineAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const lineId = String(formData.get("lineId") ?? "");
  await ownedEditableInvoice(invoiceId, user.garageId);

  await prisma.invoiceLine.deleteMany({ where: { id: lineId, invoiceId } });
  await recomputeInvoice(invoiceId, user.garageId);
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/cashier");
}

// ────────────────────────────────────────────────────────────────
// Invoice-level discount — applied BEFORE VAT, per spec.
//
// We don't add new schema columns for this. A discount is stored as
// a single FEE line with a negative amount and a marker description
// of the form 'Discount (<n>%)' or 'Discount (fixed)'. That way the
// existing recomputeInvoice() math 'just works':
//   invoice.subtotal = sum(all lines incl. negative discount)
//   invoice.vatAmount = invoice.subtotal × 0.05
//   invoice.total    = invoice.subtotal + invoice.vatAmount
// which is exactly the spec's order (subtotal → discount → VAT →
// total).
//
// The marker description distinguishes the discount line from a
// random FEE line a cashier might add by hand. The UI shows the
// discount in the totals area, NOT in the line table.
// ────────────────────────────────────────────────────────────────

// Marker is kept as a local non-exported const in this file. Next.js
// "use server" modules can ONLY export async functions — exporting a
// regexp const from here breaks the entire module (Turbopack: 'The
// export X was not found in module …'). Callers that need the same
// pattern should import it from src/lib/invoice-discount.ts instead.
const DISCOUNT_DESCRIPTION_MARKER = /^Discount \(/;

export async function setInvoiceDiscountAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  await ownedEditableInvoice(invoiceId, user.garageId);

  // 'mode' is the cashier's choice: PERCENT, AMOUNT, or NONE (remove).
  // We accept the value as a number; for PERCENT it's a percentage
  // (e.g. 2 means 2%), for AMOUNT it's an AED amount (e.g. 200).
  const mode = String(formData.get("mode") ?? "NONE").toUpperCase();
  const rawValue = Math.abs(Number(formData.get("value") ?? 0));
  const isPercent = mode === "PERCENT";
  const isAmount = mode === "AMOUNT";

  // Always wipe any existing discount line(s) first so applying a new
  // discount fully replaces the previous one, no stacking. We also
  // delete BEFORE computing the gross subtotal so the gross figure
  // matches 'subtotal of real work', not the post-prior-discount one.
  const allLines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
  const discountLineIds = allLines
    .filter((l) => DISCOUNT_DESCRIPTION_MARKER.test(l.description))
    .map((l) => l.id);
  if (discountLineIds.length > 0) {
    await prisma.invoiceLine.deleteMany({ where: { id: { in: discountLineIds } } });
  }

  if (isPercent || isAmount) {
    // Gross subtotal = sum of all non-discount lines (the parts +
    // labour the customer is being billed for, before any discount).
    const grossSubtotal = allLines
      .filter((l) => !DISCOUNT_DESCRIPTION_MARKER.test(l.description))
      .reduce((s, l) => s + Number(l.lineTotal), 0);

    let discountAmount = 0;
    let description = "Discount";
    if (isPercent) {
      const pct = Math.min(100, rawValue); // can't discount more than 100%
      discountAmount = Math.round(grossSubtotal * (pct / 100) * 100) / 100;
      description = `Discount (${pct}%)`;
    } else {
      // Fixed amount — cap at gross so we don't end up with a negative
      // subtotal (and a refund situation no one asked for).
      discountAmount = Math.min(rawValue, grossSubtotal);
      description = `Discount (fixed)`;
    }

    if (discountAmount > 0) {
      const unitPrice = -discountAmount;
      await prisma.invoiceLine.create({
        data: {
          invoiceId,
          kind: "FEE",
          description,
          qty: 1,
          unitPrice,
          lineTotal: lineTotal(1, unitPrice),
        },
      });
    }
  }

  await recomputeInvoice(invoiceId, user.garageId);
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/cashier");
}

/**
 * Cashier taps 'Send via WhatsApp' on an invoice. Same pattern as
 * sendPurchaseOrderWhatsAppAction (`src/app/actions/purchasing.ts`):
 * we do NOT send anything to Meta. Instead we build the message body
 * + signed customer-facing URL, log an InvoiceSend audit row, then
 * redirect the operator to wa.me/<phone>?text=<encoded body> so the
 * customer's phone number opens in WhatsApp on the operator's device
 * with the message pre-filled. The operator taps Send inside their
 * own WhatsApp.
 *
 * `JobCard.invoiceSentAt` now means "handed to the operator's
 * WhatsApp," not "the customer received it." Every read site was
 * reworded in the same commit that introduced this shape (see the
 * three i18n keys `invoiceSentAt`, `invoiceAlreadySent`,
 * `tlInvoiceSent`, and the `/invoices/[id]/sent` title). When the
 * Meta Cloud API commit follows, the stamp semantics tighten back to
 * "sent" — the wording flips at the i18n layer, no surface code
 * changes.
 *
 * We write the audit row BEFORE the redirect, and we stamp
 * `invoiceSentAt` in the same step so the read side ("this row moved
 * out of To send") tracks the audit. If the redirect never fires
 * (server crash) the audit row shows HANDED_OFF without a paper
 * trail on the operator's phone — that's the correct signal that
 * something went sideways at hand-off time, not a claim we made up.
 */
export async function sendInvoiceToCustomerAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, garageId: user.garageId },
    select: {
      id: true,
      jobCardId: true,
      number: true,
      issuedAt: true,
      total: true,
      // Vehicle drives the "your invoice for the {make} {model}" copy
      // in the message body — pulled here so the message reads
      // naturally without an extra join at render time.
      jobCard: {
        select: {
          vehicle: {
            select: {
              make: true,
              model: true,
              customer: {
                select: { name: true, phone: true, waId: true, lang: true },
              },
            },
          },
        },
      },
    },
  });
  if (!inv) throw new Error("Invoice not found in this garage");

  const customer = inv.jobCard.vehicle.customer;
  // wa.me needs an E.164 number without the leading '+'. Prefer waId
  // (already normalized in the DB when we have it from a chat) then
  // fall back to `phone`. Refuse to redirect if we can't normalize —
  // otherwise the wa.me URL fails silently on the operator's phone
  // and they blame the app for not sending.
  const rawPhone = customer.waId ?? customer.phone;
  const phoneE164 = normalizeToE164(rawPhone);
  if (!phoneE164) {
    throw new Error(
      "Customer phone is missing or malformed — can't open WhatsApp for the send.",
    );
  }

  const body = invoiceMessage({
    customer: { name: customer.name, lang: customer.lang },
    vehicle: {
      make: inv.jobCard.vehicle.make,
      model: inv.jobCard.vehicle.model,
    },
    invoice: { total: Number(inv.total), number: inv.number },
    appUrl: appUrl(),
    invoiceId: signId("invoice", inv.id),
  });
  const waHref = buildWaMeUrl(phoneE164, body);

  // Stamp the "handed off" timestamp + flip the row out of the
  // dashboard "To send" bucket in the same transaction. Once the Meta
  // Cloud API commit lands this becomes "sent" outright; today it's
  // an operator-hand-off stamp and every read site is reworded to
  // match.
  await prisma.jobCard.update({
    where: { id: inv.jobCardId },
    data: { invoiceSentAt: new Date() },
  });

  // Sender name snapshot — the JWT's `name` field, else email. Frozen
  // on the audit row so a rename or offboarding can't rewrite who
  // handed the invoice off.
  const senderName = user.name?.trim() || user.email || "unknown";
  await logInvoiceSend({
    invoiceId: inv.id,
    garageId: user.garageId,
    channel: "WHATSAPP",
    recipient: phoneE164,     // snapshot of the number wa.me opened
    sentByUserId: user.id,
    sentByName: senderName,
    status: "HANDED_OFF",     // wa.me can't observe delivery
  });

  revalidatePath("/cashier");
  revalidatePath("/advisor");
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath(`/advisor/jobs/${inv.jobCardId}`);
  redirect(waHref);
}

/**
 * Mock 'Email Invoice' — the send path when SMTP eventually lands.
 * KEPT (2026-08-11) but the button is hidden until real email is
 * wired: business customers ask for emailed invoices, and rebuilding
 * this action + its role gate + its i18n later would be pure churn.
 *
 * Today this only writes a server-log line. It does NOT stamp any
 * "sent" flag and it does NOT redirect with a "success" query
 * parameter — the previous version did both, which is how the UI
 * ended up claiming "Invoice emailed to customer" while no email
 * left the box. The bug that flagged this (AR, 2026-08-11): "same
 * class of problem as the invoice-sent stamp — a cashier telling a
 * customer their invoice was emailed when it wasn't is worse than
 * no email option."
 *
 * When wiring real SMTP (Resend / SES / Mailgun), reintroduce the
 * "sent" side effects then — an emailSentAt column on JobCard or
 * InvoiceSend row, an honest confirmation banner, and finally re-
 * enable the button in /invoices/[id].
 */
export async function emailInvoiceAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, garageId: user.garageId },
    select: { id: true, jobCardId: true, number: true, issuedAt: true },
  });
  if (!inv) throw new Error("Invoice not found in this garage");

  const customer = await customerForJob(inv.jobCardId, user.garageId);
  if (!customer) throw new Error("Customer not found for this invoice");
  if (!customer.email) {
    throw new Error("Customer has no email on file");
  }

  // Mock — no SMTP yet. See action doc-comment above.
  console.log(
    `[mock-email] would send invoice ${inv.number} to ${customer.email} — ${appUrl()}/c/invoice/${signId("invoice", inv.id)}`,
  );

  revalidatePath(`/invoices/${invoiceId}`);
  redirect(`/invoices/${invoiceId}`);
}

export async function recordPaymentAction(formData: FormData) {
  // Cashier or owner records payment (record-only: cash / card-POS).
  const user = await requireAnyRole(INVOICE_ROLES);
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

  // Overpayment block — slice 6 spec rule: 'a payment can never
  // exceed the balance due'. Enforce here so a hand-crafted POST or
  // a stale browser tab can't sneak past the UI gate. 0.01 epsilon
  // covers floating-point round-off so a payment that equals the
  // balance to the cent still goes through.
  const paidBefore = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const total = Number(inv.total);
  if (paidBefore + amount > total + 0.01) {
    const balanceLeft = Math.max(0, total - paidBefore);
    throw new Error(
      `Payment exceeds balance due. Outstanding: AED ${balanceLeft.toFixed(2)}.`,
    );
  }

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
    const paidSoFar = paidBefore + amount;
    if (paidSoFar >= total) {
      await tx.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });
    }
  });

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/cashier");
}

// ────────────────────────────────────────────────────────────────
// Slice 6b — recordAdvancePaymentAction.
// Records an advance against a JOB CARD whose estimate has been
// approved but whose invoice has not yet been generated. Stores an
// AdvancePayment row, writes DR Cash / CR Customer Deposits, and
// blocks overpayment vs. the sum of all approved estimates' totals.
//
// At TECH_COMPLETE → Generate Invoice, generateInvoiceAction (above)
// migrates every unmigrated AdvancePayment for the job onto the new
// invoice as a Payment + DR Customer Deposits / CR AR reclassification,
// so the freshly-issued invoice opens already showing the advance and
// the right Balance Due / Partially Paid state.
//
// Why a separate model rather than 'just create a draft invoice early':
// invoice numbering is gapless per-garage (VAT requirement). Issuing
// an invoice before work is done would burn a number even if the work
// were later cancelled. Advances need to be recordable without
// committing to an invoice number, hence AdvancePayment on the job.
// ────────────────────────────────────────────────────────────────
export async function recordAdvancePaymentAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const jobCardId = String(formData.get("jobCardId") ?? "");
  const amount = Math.max(0, Number(formData.get("amount") ?? 0));
  const method = String(formData.get("method") ?? "CASH");
  if (!isRecordableMethod(method)) {
    throw new Error("Online payment links aren't available yet — use Cash or Card (POS).");
  }
  if (amount <= 0) throw new Error("Amount must be positive");

  // Load the job + tenancy-scoped approved-estimate totals + existing
  // advances + any invoice that may already exist. Single query, no
  // round trips, so the overpayment math is computed against a
  // consistent snapshot.
  const job = await prisma.jobCard.findFirst({
    where: { id: jobCardId, garageId: user.garageId },
    include: {
      estimates: {
        where: { status: "APPROVED" },
        select: { id: true, total: true },
      },
      advancePayments: { select: { amount: true } },
      invoices: { select: { id: true } },
    },
  });
  if (!job) throw new Error("Job not found");

  // Already invoiced? The cashier should use the invoice payment form,
  // not the advance form. Throwing here makes a stale tab fail loudly
  // instead of silently double-recording money against the same job.
  if (job.invoices.length > 0) {
    throw new Error(
      "Invoice already generated — record payment on the invoice instead.",
    );
  }

  if (job.estimates.length === 0) {
    throw new Error("No approved estimate yet — can't take an advance.");
  }

  // Use the SUM of approved-estimate totals as the ceiling. Mirrors
  // generateInvoiceAction's merge behaviour: if a re-estimate adds
  // extras after first approval, the total ceiling grows with it.
  const approvedTotal = job.estimates.reduce(
    (s, e) => s + Number(e.total),
    0,
  );
  const advancesSoFar = job.advancePayments.reduce(
    (s, a) => s + Number(a.amount),
    0,
  );
  // 0.01 epsilon: matches recordPaymentAction. A final advance equal
  // to the approved total to the cent must clear.
  if (advancesSoFar + amount > approvedTotal + 0.01) {
    const remaining = Math.max(0, approvedTotal - advancesSoFar);
    throw new Error(
      `Advance exceeds approved estimate total. Remaining: AED ${remaining.toFixed(2)}.`,
    );
  }

  // Primary approved estimate id — used to revalidate the surface the
  // cashier most likely came from.
  const primaryEstimateId = job.estimates[0].id;

  await prisma.$transaction(async (tx) => {
    const advance = await tx.advancePayment.create({
      data: {
        garageId: user.garageId,
        jobCardId: job.id,
        amount,
        method,
      },
      select: { id: true },
    });
    await tx.ledgerEntry.createMany({
      data: advanceLedger(amount).map((e) => ({
        garageId: user.garageId,
        account: e.account,
        debit: e.debit,
        credit: e.credit,
        sourceType: "ADVANCE",
        sourceId: advance.id,
      })),
    });
  });

  revalidatePath(`/estimates/${primaryEstimateId}`);
  revalidatePath("/cashier");
}

// ─────────────────────────────────────────────────────────────────
// Void + reissue (2026-08-10)
// ─────────────────────────────────────────────────────────────────
//
// Once an invoice is DELIVERED (invoiceDeliveredAt set), lines are
// locked and edits reject. The FTA-correct correction path is:
//   1. Void the delivered invoice — status → VOID, voidedAt +
//      voidedByUserId stamped, but the row keeps its number.
//   2. Reissue — clone the void's lines into a fresh invoice on the
//      same JobCard. The new row takes the NEXT invoiceSeq value
//      and carries `previousInvoiceId` pointing at the void.
//      Sequence stays gapless (…0038, 0039 VOID, 0040 SENT).
//
// The two actions are separate — the cashier voids, then either
// reissues or leaves the correction for later. `voidInvoiceAction`
// is idempotent (repeated voids on the same row are a no-op).
// `reissueInvoiceAction` refuses if the void already has a
// replacedBy (previousInvoiceId is @unique on the correction row).

/**
 * Cancel a delivered invoice.
 *
 * Guard chain:
 *   - INVOICE_ROLES (cashier / owner / master)
 *   - Invoice belongs to caller's garage
 *   - Invoice is DELIVERED (invoiceDeliveredAt IS NOT NULL) — void is
 *     the escape hatch for documents that have reached the customer.
 *     Not-yet-delivered invoices should be edited in place instead.
 *   - Invoice status !== VOID (idempotent no-op on repeat)
 *   - Invoice status !== PAID (payments block void — refund path is
 *     out of scope, would need a proper credit note. Report to
 *     operator so they don't lose the payment history quietly.)
 *
 * On success: status=VOID, voidedAt=now, voidedByUserId=user.
 * Ledger entries are NOT reversed here — the reissued invoice's
 * ledger takes over. If we ever add credit notes (Phase 2), they
 * write the reversal entries; the void alone doesn't move money.
 */
export async function voidInvoiceAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const back = `/invoices/${invoiceId}`;

  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, garageId: user.garageId },
    select: {
      id: true,
      status: true,
      jobCard: { select: { invoiceDeliveredAt: true } },
    },
  });
  if (!inv) throw new Error("Invoice not found in this garage");
  if (!inv.jobCard.invoiceDeliveredAt) {
    // Not yet delivered — the correct fix is line editing, which the
    // page's edit surface still permits under the 2026-08-10 lock
    // shape. Guiding the operator here rather than silently accepting
    // the void keeps the audit trail clean.
    throw new Error(
      "This invoice hasn't been delivered yet — edit it directly instead of voiding.",
    );
  }
  if (inv.status === "VOID") {
    // Idempotent — repeated tap on the same button by an anxious
    // cashier shouldn't error.
    redirect(back);
  }
  if (inv.status === "PAID") {
    throw new Error(
      "This invoice has been paid — voiding it would leave the payment orphaned. A credit note is needed for corrections after payment.",
    );
  }

  await prisma.invoice.update({
    where: { id: inv.id },
    data: {
      status: "VOID",
      voidedAt: new Date(),
      voidedByUserId: user.id,
    },
  });

  revalidatePath(back);
  revalidatePath("/cashier");
  redirect(back);
}

/**
 * Issue a correction invoice for a voided one.
 *
 * Clones the void's lines into a fresh invoice on the same JobCard,
 * consumes the next invoiceSeq value, and writes
 * `previousInvoiceId` on the new row pointing at the void. The
 * @unique index on previousInvoiceId means one void → one correction;
 * a second reissue attempt against the same void throws (P2002).
 *
 * The correction opens in the DRAFT-not-sent state so the cashier
 * can add the missing line / adjust prices, then hits Send via
 * WhatsApp normally. The customer receives a fresh Tax Invoice
 * that cross-references the void ("Replaces INV-…").
 *
 * Guard chain:
 *   - INVOICE_ROLES
 *   - Void row exists in caller's garage AND is status=VOID.
 *   - Void row doesn't already have a replacedBy (unique index also
 *     enforces this, but we check first for a clean error).
 */
export async function reissueInvoiceAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const voidedId = String(formData.get("invoiceId") ?? "").trim();

  const voided = await prisma.invoice.findFirst({
    where: { id: voidedId, garageId: user.garageId },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      replacedBy: { select: { id: true, number: true } },
    },
  });
  if (!voided) throw new Error("Invoice not found in this garage");
  if (voided.status !== "VOID") {
    throw new Error(
      "Only a voided invoice can be reissued — void the original first.",
    );
  }
  if (voided.replacedBy) {
    // Belt-and-braces: the @unique index would also catch this on
    // the write, but a friendlier error here saves debugging time.
    redirect(`/invoices/${voided.replacedBy.id}`);
  }

  const now = new Date();
  const dueDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const strategy = vatStrategyFor("UAE");
  const subtotal = Number(voided.subtotal);
  const vatAmount = Number(voided.vatAmount);
  const total = Number(voided.total);

  const newInvoiceId = await prisma.$transaction(async (tx) => {
    const g = await tx.garage.update({
      where: { id: user.garageId },
      data: { invoiceSeq: { increment: 1 } },
      select: { invoiceSeq: true, name: true, trn: true },
    });

    // Re-snapshot the customer TRN — it may have been corrected on
    // the customer record since the void was issued (that's often
    // WHY a correction is being made).
    const jobForCustomer = await tx.jobCard.findUnique({
      where: { id: voided.jobCardId },
      select: { vehicle: { select: { customer: { select: { trn: true } } } } },
    });
    const customerTrnSnapshot = jobForCustomer?.vehicle.customer.trn ?? null;

    const inv = await tx.invoice.create({
      data: {
        garageId: user.garageId,
        jobCardId: voided.jobCardId,
        // No estimateId link — the reissue is a fresh document and
        // Invoice.estimateId is @unique, so it can't share the void's.
        estimateId: null,
        number: g.invoiceSeq,
        previousInvoiceId: voided.id,
        customerTrn: customerTrnSnapshot,
        issuedAt: now,
        dueDate,
        subtotal,
        vatAmount,
        total,
        // DRAFT so the cashier can adjust before sending — the whole
        // point of reissue is that the void was wrong.
        status: "DRAFT",
        clearanceStatus: strategy.clearanceStatus,
        qrPayload: qrPlaceholder({
          seller: g.name,
          trn: g.trn,
          total,
          vat: vatAmount,
          isoDate: now.toISOString(),
        }),
        lines: {
          create: voided.lines.map((l) => ({
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

    // Clear the JobCard.invoiceSentAt / invoiceDeliveredAt so the new
    // draft can be handed off + delivered independently. The void
    // keeps its own stamps intact for audit; only the JobCard
    // pointers reset, which is what the send / delivery flow reads.
    await tx.jobCard.update({
      where: { id: voided.jobCardId },
      data: { invoiceSentAt: null, invoiceDeliveredAt: null },
    });

    // NOTE: we deliberately do NOT write ledger rows here. The void
    // hasn't been reversed and the new invoice is DRAFT — ledger
    // shape comes from the eventual send/pay events on the new row.
    // If we double-wrote invoiceLedger here, AR would be counted
    // twice until the void was ledger-reversed. Correcting that is
    // a Phase 2 concern (credit note); for now, cashier-issued
    // corrections in the wa.me era are rare enough that a manual
    // ledger cleanup at void time is acceptable.

    return inv.id;
  });

  revalidatePath(`/invoices/${voidedId}`);
  revalidatePath(`/invoices/${newInvoiceId}`);
  revalidatePath("/cashier");
  redirect(`/invoices/${newInvoiceId}`);
}
