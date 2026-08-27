"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import {
  totalsFor,
  lineTotal,
  invoiceLedger,
  voidReversalLedger,
  paymentLedger,
  advanceLedger,
  advanceMigrationLedger,
  vatStrategyFor,
  qrPlaceholder,
  isRecordableMethod,
  isQuoteIncrease,
  jobPartLineDescription,
  parseLineEditInput,
  parseMoney,
  priceErrorCode,
  lineEditErrorCode,
  findZeroPricedPartLines,
  formatInvoiceNo,
  type DraftLine,
  type LineKind,
} from "@/lib/billing";
import { sendWhatsApp, appUrl } from "@/lib/whatsapp";
import { resolveCustomerLangForOutbound } from "@/lib/customer-lang";
import { ensurePublicToken, newPublicToken } from "@/lib/document-tokens";
import { buildWaMeUrl, normalizeToE164 } from "@/lib/wa";
import { closeJobSessions } from "@/lib/work-session";
import { invoiceMessage, estimateMessage } from "@/lib/po-message";
import { logInvoiceSend } from "@/lib/invoice-send-log";
import { ESTIMATE_CREATE_ROLES, INVOICE_ROLES, SEND_ROLES } from "@/lib/permissions";
import { requireAnyRole } from "@/lib/action-guards";
import { revalidateEstimateStaffSurfaces } from "@/lib/revalidate-estimate-surfaces";
import { resolveInvoiceLineCost } from "@/lib/invoice-cost-snapshot";

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
        publicToken: newPublicToken(),
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
  //
  // Also pull cost + price (AR 2026-08-12 Step 4) so a catalog-linked PART
  // line prefills unitCost + derives an initial markup — either from the
  // catalogue's own price/cost ratio (which preserves whatever markup the
  // owner set on the Part row) or, if the catalogue only has a price with
  // no cost, from Garage.defaultPartsMarkupPct.
  const partIdRaw = String(formData.get("partId") ?? "").trim();
  const linkedPart = partIdRaw
    ? await prisma.part.findFirst({
        where: { id: partIdRaw, garageId: user.garageId },
        select: { id: true, name: true, sku: true, cost: true, price: true },
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
  // AR 2026-08-17 — parseMoney rejects blanks instead of silently
  // writing unitPrice: 0 (see estimate-line-blank-price-spec.md). A
  // blank on a real line was flowing through to invoice + ledger +
  // filed VAT return under-counted. DISCOUNT parses allowNegative
  // because sign-flip is legal for that sugar-kind; regular lines
  // reject negatives.
  const parsedPrice = parseMoney(formData.get("unitPrice"), {
    allowNegative: isDiscount,
  });
  if (!parsedPrice.ok) {
    // AR 2026-08-18 — redirect back with a code, not throw. Throwing
    // hits Next's generic error boundary ("Something went wrong / ref
    // <digest>") and the advisor never sees the operator-facing text.
    // Source page renders the banner from ?formError=<code>; see
    // lib/billing.ts LINE_FORM_ERROR_CODES.
    redirect(`/estimates/${estimateId}?formError=${priceErrorCode(parsedPrice.error)}`);
  }
  const priceAbs = Math.abs(parsedPrice.value);
  const unitPrice = isDiscount ? -priceAbs : priceAbs;

  // Cost-based prefill (AR 2026-08-12) — only meaningful for PART lines.
  // Priority:
  //   1. Catalog-linked with cost>0 → unitCost = Part.cost.
  //      markupPct = round((price/cost - 1)*100, 2) so the catalogue's
  //      implied markup is what the advisor sees on first open.
  //   2. Catalog-linked with cost=0/null but Garage.defaultPartsMarkupPct
  //      set → use the shop-wide markup as a hint (unitCost null).
  //   3. Free-text PART line → both null; advisor fills them in edit.
  let unitCost: number | null = null;
  let markupPct: number | null = null;
  if (kind === "PART" && linkedPart) {
    const c = Number(linkedPart.cost);
    const p = Number(linkedPart.price);
    if (Number.isFinite(c) && c > 0) {
      unitCost = c;
      if (Number.isFinite(p) && p > 0) {
        markupPct = Math.round((p / c - 1) * 100 * 100) / 100;
      }
    }
  }
  if (kind === "PART" && markupPct == null) {
    const g = await prisma.garage.findUnique({
      where: { id: user.garageId },
      select: { defaultPartsMarkupPct: true },
    });
    if (g?.defaultPartsMarkupPct != null) {
      markupPct = Number(g.defaultPartsMarkupPct);
    }
  }

  await prisma.estimateLine.create({
    data: {
      estimateId,
      kind,
      partId: linkedPart?.id ?? null,
      description,
      qty,
      unitCost,
      markupPct,
      unitPrice,
      lineTotal: lineTotal(qty, unitPrice),
    },
  });
  await recomputeEstimate(estimateId);
  revalidatePath(`/estimates/${estimateId}`);
}

/**
 * "Price this part" — turn a technician-required JobPart into a
 * priced EstimateLine.
 *
 * AR 2026-08-19 rewrite. Historical shape looked up the catalogue
 * Part.price and refused when there wasn't one; the refusal banner
 * told the advisor to "add the part to Inventory". That advice
 * violates business-rules.md rule 1 (parts are two kinds, direct-
 * fit must NEVER create catalogue records) — the majority of
 * tech-requested parts are direct-fit for one car and never enter
 * stock. Following the old advice is exactly how the AUTO-* duplicate
 * SKUs in issue #19 were created (ENGINE-OIL @ 180 shadowing
 * OIL-5W30 @ 35).
 *
 * The new shape: the advisor types unit cost + unit price on an
 * inline form on the JobPart row. This action accepts those form
 * values verbatim, creates an EstimateLine with `partId =
 * jp.partId` (may be null for direct-fit), and NEVER writes to
 * Part. Adding a part to Inventory becomes a deliberate separate
 * action on /owner/inventory — not a side effect of pricing a
 * line.
 *
 * Duplicate-click guard: on success, JobPart.estimateLineId is set
 * to the new line's id. The PartRow UI hides the "Price this part"
 * button once set. The FK is @unique + ON DELETE SET NULL — if the
 * advisor deletes the resulting EstimateLine, the JobPart becomes
 * priceable again.
 */
export async function addLineFromPartAction(formData: FormData) {
  const user = await requireAnyRole(ESTIMATE_CREATE_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const jobPartId = String(formData.get("jobPartId") ?? "");
  const est = await ownedEstimate(estimateId, user.garageId);
  if (est.status !== "DRAFT") throw new Error("Estimate is not editable");

  const jp = await prisma.jobPart.findFirst({
    where: { id: jobPartId, jobCardId: est.jobCardId },
    // partId still pulled — when the tech DID pick a catalogue part,
    // we preserve the link on the EstimateLine (stock-path
    // provenance). part.cost/price are NOT read anymore — the form
    // values win at write, per rule 5 (blank ≠ zero).
    select: {
      id: true,
      partId: true,
      partNo: true,
      description: true,
      qty: true,
      estimateLineId: true,
    },
  });
  if (!jp) throw new Error("Part not found on this job");
  // Duplicate-click guard, server side. The PartRow UI hides the
  // button once JobPart.estimateLineId is set, but a stale tab or a
  // hand-crafted POST could still reach here. Redirect quietly
  // rather than creating a second line — the advisor asked us to
  // do a thing that's already done.
  if (jp.estimateLineId) {
    redirect(`/estimates/${estimateId}`);
  }

  // Qty comes from the form (advisor may adjust the tech's number).
  // Fall back to jp.qty if the form field is missing — same shape
  // as the manual Add-line qty field.
  const rawQty = Number(formData.get("qty") ?? jp.qty);
  const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : jp.qty;

  // Price fields — required. parseMoney enforces rule 5 (blank ≠
  // zero); the operator can still type "0" explicitly for a
  // warranty/courtesy part, and it will pass. The exit-gate on
  // send/invoice catches un-declined 0.00 PART lines with a
  // confirmable banner. AR 2026-08-19.
  const parsedCost = parseMoney(formData.get("unitCost"));
  if (!parsedCost.ok) {
    redirect(`/estimates/${estimateId}?formError=${priceErrorCode(parsedCost.error)}`);
  }
  const parsedPrice = parseMoney(formData.get("unitPrice"));
  if (!parsedPrice.ok) {
    redirect(`/estimates/${estimateId}?formError=${priceErrorCode(parsedPrice.error)}`);
  }
  const unitCost = parsedCost.value;
  const unitPrice = parsedPrice.value;

  // Implicit markup pct — derived so the row-editor's tri-input keeps
  // working after this line lands. Cost > 0 required; when cost is
  // 0 (a comp), markupPct is undefined and stays null. Same math as
  // addEstimateLineAction's catalogue prefill path.
  const markupPct =
    unitCost > 0 && Number.isFinite(unitPrice / unitCost)
      ? Math.round((unitPrice / unitCost - 1) * 100 * 100) / 100
      : null;

  // Transactionally: create the EstimateLine, then link it back to
  // the JobPart so the PartRow UI can hide its button. If either
  // fails, both roll back — a JobPart with a non-existent
  // estimateLineId is a foot-gun.
  await prisma.$transaction(async (tx) => {
    const line = await tx.estimateLine.create({
      data: {
        estimateId,
        kind: "PART",
        // partId preserved when the tech picked from catalogue. Null
        // otherwise (direct-fit path). Rule 1 — we NEVER create a
        // catalogue row here.
        partId: jp.partId,
        description: jobPartLineDescription(jp.partNo, jp.description),
        qty,
        unitCost,
        markupPct,
        unitPrice,
        lineTotal: lineTotal(qty, unitPrice),
      },
      select: { id: true },
    });
    await tx.jobPart.update({
      where: { id: jp.id },
      data: { estimateLineId: line.id },
    });
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
  // AR 2026-08-17 — see the parseMoney note in addEstimateLineAction.
  // The sign of the EXISTING line decides whether we allow negative
  // input (this preserves the DISCOUNT convention on inline edit).
  const wasDiscount = Number(line.unitPrice) < 0;
  const parsedPrice = parseMoney(formData.get("unitPrice"), {
    allowNegative: wasDiscount,
  });
  if (!parsedPrice.ok) {
    redirect(`/estimates/${estimateId}?formError=${priceErrorCode(parsedPrice.error)}`);
  }
  const priceAbs = Math.abs(parsedPrice.value);
  const unitPrice = wasDiscount ? -priceAbs : priceAbs;
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
    // Cost-based inputs (AR 2026-08-12) — only present when the
    // advisor edited a PART line; parseLineEditInput nulls them out
    // for non-PART kinds so a mid-edit LABOR ↔ PART swap doesn't
    // stash stale cost data.
    unitCost: formData.get("unitCost"),
    markupPct: formData.get("markupPct"),
  });
  if (!parsed.ok) {
    // AR 2026-08-18 — redirect with a code instead of throw. Same
    // pattern as add-line: source page reads ?formError=<code> and
    // renders a banner.
    redirect(`/estimates/${estimateId}?formError=${lineEditErrorCode(parsed.error)}`);
  }
  const { kind, description, qty, unitPrice, unitCost, markupPct } = parsed;

  await prisma.estimateLine.update({
    where: { id: lineId },
    data: {
      kind,
      description,
      qty,
      unitPrice,
      lineTotal: lineTotal(qty, unitPrice),
      // Persist verbatim. When kind !== PART parseLineEditInput
      // already forced both to null, so a kind swap clears them.
      unitCost,
      markupPct,
    },
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
      // Phase 2 (2026-08-10): raw publicToken instead of HMAC signId.
      // ensurePublicToken is a no-op when the row already has a token
      // (Phase-1 backfill covered every existing row); it generates
      // one for the rare row created between backfill and this
      // deploy landing. Belt-and-braces so no send emits a link that
      // can't be verified.
      const publicToken = await ensurePublicToken("estimate", est);
      await sendWhatsApp({
        garageId: user.garageId,
        customerId: customer.id,
        waId: customer.waId ?? customer.phone,
        template: "estimate_approval",
        body: `Your estimate is ready. Review & approve: ${appUrl()}/c/estimate/${publicToken}`,
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
        // Wrench-time stops when a job pauses for extra-work
        // approval — no work happens while we wait for the customer
        // to bless the higher price. AR 2026-08-20 Finding 2.
        await closeJobSessions(est.jobCardId, "JOB_CLOSED");
      }
    }
  }
  // AR 2026-08-28 — was two revalidatePath calls, which left the
  // /advisor/estimates bucket list + /cashier dashboard serving
  // cached RSC saying SENT after the DB flipped to APPROVED. The
  // customer-facing path in public.ts had the full set; the
  // advisor path here silently didn't. Central helper closes the
  // gap and stops it drifting again.
  revalidateEstimateStaffSurfaces(est.jobCardId, estimateId);
}

/**
 * Send an estimate to the customer via WhatsApp hand-off (AR 2026-08-16,
 * INV-2026-0048 sibling report — estimate send was silently mocking
 * away in prod because it still used the pre-wa.me `sendWhatsApp`
 * helper which no-ops without Meta Cloud API creds).
 *
 * Mirror of sendInvoiceToCustomerAction (billing.ts:1055):
 *
 *   1. Resolve customer + vehicle + garage
 *   2. Build the customer-facing message via estimateMessage()
 *   3. Build the wa.me URL via buildWaMeUrl (picker fallback on bad
 *      phone matches invoice behaviour)
 *   4. Stamp Estimate.sentAt = now() (idempotent — resend updates
 *      the timestamp, matches invoice-side JobCard.invoiceSentAt)
 *   5. On the FIRST send (est.status !== SENT): flip status to SENT
 *      and re-run the quote-approval-gate check that used to live
 *      inside setEstimateStatusAction's SENT branch. Later resends
 *      skip both — the status is already SENT and re-checking
 *      isQuoteIncrease against the same value is a no-op.
 *   6. Revalidate + redirect to wa.me — the load-bearing step. The
 *      old path revalidated + returned; the browser stayed on the
 *      preview page and WhatsApp never opened.
 *
 * Called from /estimates/[id]/preview — both the initial Send and
 * a Resend on an already-SENT estimate. setEstimateStatusAction's
 * SENT branch is now defensive-only (nothing in the UI submits to
 * it with status=SENT).
 */
export async function sendEstimateToCustomerAction(formData: FormData) {
  const user = await requireAnyRole(SEND_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  // Garage-scope via the jobCard relation (Estimate has no garageId
   // column — same pattern ownedEstimate uses).
  const est = await prisma.estimate.findFirst({
    where: { id: estimateId, jobCard: { garageId: user.garageId } },
    select: {
      id: true,
      jobCardId: true,
      status: true,
      // AR 2026-08-23 — sentAt is now the "first send" signal, not
      // `status !== "SENT"`. See the isFirstSend derivation below.
      sentAt: true,
      subtotal: true,
      vatAmount: true,
      total: true,
      publicToken: true,
      lines: {
        // AR 2026-08-18 — widened to include kind + unitPrice for the
        // exit gate below (refuse to send when any non-declined PART
        // line is 0.00). partId isn't needed today; if we ever add
        // a courtesy-flag lookup, add it back here.
        select: { kind: true, qty: true, description: true, declined: true, unitPrice: true },
        orderBy: { createdAt: "asc" },
      },
      jobCard: {
        select: {
          number: true,
          // Batch F1 (2026-08-25): garage.phone is the fallback when
          // the advisor's User.phone is null — the shop's main line
          // is better than no callback number on the customer's copy.
          garage: { select: { name: true, phone: true } },
          // Advisor snapshot fields — AR 2026-08-25 Batch C. Captured
          // onto Estimate.advisorNameSnapshot + advisorPhoneSnapshot
          // at send time so the customer's copy of the doc still names
          // the right person after a staff change. Same discipline as
          // InvoiceLine.unitCost being snapshotted at invoice-generation.
          advisor: { select: { name: true, phone: true } },
          vehicle: {
            select: {
              make: true,
              model: true,
              year: true,
              plate: true,
              vin: true,
              engineSize: true,
              fuelType: true,
              customer: {
                select: { id: true, name: true, phone: true, waId: true, lang: true },
              },
            },
          },
        },
      },
    },
  });
  if (!est) throw new Error("Estimate not found in this garage");

  // AR 2026-08-23 — refuse to hand off an estimate the customer
  // has already decided on. Previous shape used
  //   `isFirstSend = est.status !== "SENT"`
  // which silently OVERWROTE approvedAt with "SENT" on any resend of
  // an APPROVED (or REJECTED) row, wiping the customer's decision
  // and leaving no audit trail. An advisor tapping Resend on an
  // already-decided estimate almost certainly meant to open the
  // customer thread for a follow-up, not to reset the workflow.
  //
  // Rejected outright at the action layer (server-side truth).
  // The preview page continues to render the estimate; the banner
  // (lineFormErr_estimate_already_approved / …_rejected) tells the
  // advisor what happened. No row is touched.
  if (est.status === "APPROVED") {
    redirect(`/estimates/${estimateId}/preview?formError=estimate-already-approved`);
  }
  if (est.status === "REJECTED") {
    redirect(`/estimates/${estimateId}/preview?formError=estimate-already-rejected`);
  }

  // Exit gate — AR 2026-08-18. Refuse to hand off an estimate that
  // contains a non-declined PART line at 0.00. Same class as the
  // JC-2026-0001 incident: four PART lines at 0.00 sailed straight
  // through send + invoice generation because nothing checked.
  //
  // Confirmable: the advisor can re-submit with confirmZeroParts=1
  // to acknowledge the zero prices are intentional (warranty /
  // courtesy). Today there's no schema flag for "intentionally free"
  // (see the report chain: EstimateLine has no isCourtesy field), so
  // the confirm dance is the intent-capture mechanism — noisy per
  // send, but no schema change required. The preview page renders a
  // banner listing the offending lines + a "Send anyway" form that
  // resubmits with confirmZeroParts=1.
  if (formData.get("confirmZeroParts") !== "1") {
    const zeroPartLines = findZeroPricedPartLines(est.lines);
    if (zeroPartLines.length > 0) {
      redirect(`/estimates/${estimateId}/preview?formError=zero-part-lines-estimate`);
    }
  }

  const customer = est.jobCard.vehicle.customer;
  const rawPhone = customer.waId ?? customer.phone;
  const phoneE164 = normalizeToE164(rawPhone);
  // DELIBERATE DIVERGENCE from sendPurchaseOrderWhatsAppAction
  // (src/app/actions/purchasing.ts). AR 2026-08-23 — do NOT unify.
  //
  //   Customer send:  bad/missing phone → phoneE164 = null →
  //                   buildWaMeUrl returns the contact-picker URL →
  //                   cashier still gets the invoice/estimate out
  //                   (picks the recipient inside WhatsApp).
  //   Supplier send:  bad/missing phone → early redirect back to the
  //                   PO detail page. Fix the supplier record before
  //                   the doc can go out.
  //
  // The asymmetry is intentional: a customer needs their invoice/
  // estimate; a PO to nobody is useless. The customer flow prefers
  // hand-off + a soft nudge (see preview-page banner) to fix the
  // record later; the supplier flow prefers to block. Aligning them
  // (either direction) trades one bad UX for another.

  // AR 2026-08-19 — detect from the customer's latest inbound
  // instead of trusting customer.lang (which is "ar" for every
  // prod row — schema default; audit 2026-08-19). Falls back to
  // customer.lang when there's no inbound to detect from.
  const detectedLang = await resolveCustomerLangForOutbound(customer.id, user.garageId);
  const publicToken = await ensurePublicToken("estimate", est);
  const body = estimateMessage({
    customer: { name: customer.name, lang: detectedLang },
    garage: { name: est.jobCard.garage.name },
    vehicle: {
      make: est.jobCard.vehicle.make,
      model: est.jobCard.vehicle.model,
      year: est.jobCard.vehicle.year ?? null,
      plate: est.jobCard.vehicle.plate ?? null,
      vin: est.jobCard.vehicle.vin ?? null,
      engineSize: est.jobCard.vehicle.engineSize ?? null,
      fuelType: est.jobCard.vehicle.fuelType ?? null,
      jobNumber: est.jobCard.number ?? null,
    },
    estimate: {
      // No per-garage Estimate.number today (invoice has one, estimate
      // doesn't) — render the cuid tail so the customer has a stable
      // ref they can quote back. Same convention invoiceMessage takes:
      // caller decides the string.
      number: `#${est.id.slice(-6).toUpperCase()}`,
      subtotal: Number(est.subtotal),
      vatAmount: Number(est.vatAmount),
      total: Number(est.total),
      lines: est.lines
        // Declined lines never reach the customer — same rule as the
        // customer /c/estimate page.
        .filter((l) => !l.declined)
        .map((l) => ({ qty: Number(l.qty), description: l.description })),
    },
    appUrl: appUrl(),
    estimateToken: publicToken,
  });
  const waHref = buildWaMeUrl(phoneE164, body);

  // AR 2026-08-23 — isFirstSend is now derived from `sentAt === null`,
  // not `status !== "SENT"`. The old derivation would fire true on
  // an APPROVED row (APPROVED !== SENT) and the `{ status: "SENT" }`
  // patch would then overwrite the customer's decision. The
  // APPROVED/REJECTED early-refuse above closes that class of
  // silent revert; the sentAt-based derivation here also makes the
  // "first send" concept semantic-truthful (a resend of a
  // successfully-sent estimate legitimately has sentAt set).
  const isFirstSend = est.sentAt === null;

  // Stamp sentAt + (first-send only) flip status. Same pattern as
  // sendInvoiceToCustomerAction: sentAt is a per-hand-off timestamp,
  // updated on every send/resend.
  //
  // AR 2026-08-25 Batch C — also snapshot the advisor's name + phone
  // onto the Estimate row. Same InvoiceLine.unitCost discipline: a
  // customer's copy of the doc should still name the right person
  // after the advisor leaves. Refresh on every send (a resend from
  // a different advisor updates the snapshot — the doc the customer
  // now holds names the current advisor). Phone snapshot is copied
  // verbatim; may be null (User.phone is nullable) which the
  // renderer handles.
  const advisor = est.jobCard.advisor;
  await prisma.estimate.update({
    where: { id: est.id },
    data: {
      sentAt: new Date(),
      ...(isFirstSend ? { status: "SENT" as const } : {}),
      advisorNameSnapshot: advisor?.name ?? null,
      // Batch F1: fall back to shop main phone when the individual
      // advisor has no personal number set. Snapshot captures whichever
      // was present at send time.
      advisorPhoneSnapshot: advisor?.phone ?? est.jobCard.garage.phone ?? null,
    },
  });

  if (isFirstSend) {
    // Quote-approval-gate — carried over verbatim from the old
    // setEstimateStatusAction SENT branch. Only runs on first send;
    // a resend of an already-SENT estimate can't change the
    // approval landscape.
    const prior = await prisma.estimate.aggregate({
      where: { jobCardId: est.jobCardId, status: "APPROVED", NOT: { id: est.id } },
      _max: { total: true },
    });
    const lastApproved = Number(prior._max.total ?? 0);
    if (isQuoteIncrease(Number(est.total), lastApproved)) {
      const job = await prisma.jobCard.findFirst({
        where: { id: est.jobCardId, garageId: user.garageId },
        select: { status: true },
      });
      if (job && job.status !== "ON_HOLD") {
        await prisma.jobCard.update({
          where: { id: est.jobCardId },
          data: {
            status: "ON_HOLD",
            heldFrom: job.status,
            holdReason: "AWAITING_APPROVAL",
          },
        });
        // AR 2026-08-20 Finding 2 — same rationale as the sibling
        // pause site earlier in this file: a job awaiting approval
        // is not being worked, wrench-time must stop.
        await closeJobSessions(est.jobCardId, "JOB_CLOSED");
      }
    }
  }

  revalidatePath(`/estimates/${estimateId}`);
  revalidatePath(`/estimates/${estimateId}/preview`);
  revalidatePath(`/advisor/jobs/${est.jobCardId}`);
  revalidatePath("/advisor");
  // The load-bearing step. Anywhere else in this action can fail
  // (customer missing, phone bad) and we STILL want to hand off —
  // buildWaMeUrl falls back to the contact-picker URL on a missing
  // phone, so the operator can still send.
  redirect(waHref);
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

  // Exit gate — AR 2026-08-18. Matters MOST here: the invoice number
  // is consumed from a gapless per-garage sequence, so correcting
  // after issue means void + reissue (a whole document lifecycle
  // event, not a line edit). Same confirmable shape as the send gate.
  // The estimate detail page renders the banner + a "Generate anyway"
  // form that resubmits with confirmZeroParts=1.
  if (formData.get("confirmZeroParts") !== "1") {
    const zeroPartLines = findZeroPricedPartLines(mergedLines);
    if (zeroPartLines.length > 0) {
      redirect(`/estimates/${estimateId}?formError=zero-part-lines-invoice`);
    }
  }

  // Cost-at-invoicing snapshot (AR 2026-08-12, corrects Step 6 of
  // cost-based pricing). For any PART line with a catalog partId,
  // read Part.cost RIGHT NOW and use that as the InvoiceLine.unitCost.
  // Fall back to the estimate's stored EstimateLine.unitCost only when
  // there's no partId (free-text lines have nothing to look up).
  //
  // The previous code copied EstimateLine.unitCost verbatim. That
  // snapshotted the cost as it was when the ADVISOR priced the line,
  // which could be days or weeks before the invoice. If a PO receipt
  // between approval and invoicing shifted Part.cost (Step 3's blend),
  // the invoice would reflect a stale number and per-invoice profit
  // would silently be wrong.
  //
  // Reading here-and-now writes the correct value into InvoiceLine
  // once and freezes it. Any later receipt affects only future
  // invoices — closed invoices never rewrite. That's exactly the
  // invariant AR asked for on 2026-08-12.
  const partIdsInInvoice = Array.from(
    new Set(mergedLines.map((l) => l.partId).filter((id): id is string => !!id)),
  );
  const partCostAtInvoicing = new Map<string, Prisma.Decimal>();
  if (partIdsInInvoice.length > 0) {
    const parts = await prisma.part.findMany({
      where: { id: { in: partIdsInInvoice }, garageId: user.garageId },
      select: { id: true, cost: true },
    });
    for (const p of parts) partCostAtInvoicing.set(p.id, p.cost);
  }
  const resolveLineCost = (l: (typeof mergedLines)[number]) =>
    resolveInvoiceLineCost(l, partCostAtInvoicing);

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
      // Cost snapshot (AR 2026-08-12, corrected): resolveLineCost re-reads
      // Part.cost RIGHT NOW for lines with a catalog part, and falls back
      // to the estimate's stored value only for free-text lines. Freezes
      // the correct cost into the invoice so a later PO receipt never
      // rewrites the profit on a job already closed.
      await prisma.invoiceLine.createMany({
        data: missing.map((l) => ({
          invoiceId: existingInvoiceId,
          kind: l.kind,
          description: l.description,
          qty: l.qty,
          unitCost: resolveLineCost(l),
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
      select: { invoiceSeq: true, name: true, trn: true, phone: true },
    });
    const seq = g.invoiceSeq;

    // Snapshot the customer's TRN at invoice-issue time. FTA rule: the
    // TRN printed on a tax invoice is what applied when it was issued;
    // if the customer's live TRN changes later (mis-typed, updated to
    // a new registration), historical invoices must not silently
    // rewrite. Invoice.customerTrn is that snapshot; renders prefer it
    // over the live customer.trn. Column has existed on Invoice since
    // 0_init — this is the first writer.
    //
    // Also snapshot the JobCard's current advisor (name + phone) at
    // this same moment as fallback for the invoice's advisor block.
    // The primary source is the source estimate's own advisor
    // snapshot (captured when the estimate was sent to the customer);
    // if the estimate wasn't sent, we fall through to whoever the
    // job currently belongs to. Snapshot at generation, never
    // rewritten — same discipline as customerTrn and unitCost.
    const jobForCustomer = await tx.jobCard.findUnique({
      where: { id: clicked.jobCardId },
      select: {
        vehicle: { select: { customer: { select: { trn: true } } } },
        advisor: { select: { name: true, phone: true } },
      },
    });
    const customerTrnSnapshot = jobForCustomer?.vehicle.customer.trn ?? null;

    // Parity blocks (AR 2026-08-25) — read from the primary (oldest
    // approved) estimate. Fall back to jobCard.advisor for the
    // advisor snapshot when the estimate wasn't sent. Phone falls
    // through advisor → garage.phone (Batch F1) so a customer meant
    // to call back always has a number on the doc when the shop
    // shares one line.
    const primaryEstimate = approvedEstimates[0];
    const invoiceRemarks = primaryEstimate.remarks;
    const invoicePaymentTerms = primaryEstimate.paymentTerms;
    const invoiceAdvisorName =
      primaryEstimate.advisorNameSnapshot ??
      jobForCustomer?.advisor?.name ??
      null;
    const invoiceAdvisorPhone =
      primaryEstimate.advisorPhoneSnapshot ??
      jobForCustomer?.advisor?.phone ??
      g.phone ??
      null;

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
        publicToken: newPublicToken(),
        // AR 2026-08-25 — parity with Estimate.
        remarks: invoiceRemarks,
        paymentTerms: invoicePaymentTerms,
        advisorNameSnapshot: invoiceAdvisorName,
        advisorPhoneSnapshot: invoiceAdvisorPhone,
        qrPayload: qrPlaceholder({
          seller: g.name,
          trn: g.trn,
          total,
          vat: vatAmount,
          isoDate: now.toISOString(),
        }),
        lines: {
          // AR 2026-08-12, corrected — cost snapshot via resolveLineCost:
          // re-reads Part.cost live for lines with a catalog part, so a
          // PO receipt landing between estimate approval and invoicing
          // flows through into this invoice's frozen unitCost. See the
          // helper defined above for the full reasoning.
          create: mergedLines.map((l) => ({
            kind: l.kind,
            description: l.description,
            qty: l.qty,
            unitCost: resolveLineCost(l),
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
  // AR 2026-08-17 — same parseMoney treatment as the estimate-side
  // sites. A live tax invoice has no "unpriced draft" concept; a
  // blank on Add-line was writing unitPrice: 0 straight onto an
  // editable invoice, propagating to subtotal/VAT/total on the next
  // recompute. Reject instead of accepting silently.
  const parsedPrice = parseMoney(formData.get("unitPrice"), {
    allowNegative: isDiscount,
  });
  if (!parsedPrice.ok) {
    redirect(`/invoices/${invoiceId}?formError=${priceErrorCode(parsedPrice.error)}`);
  }
  const priceAbs = Math.abs(parsedPrice.value);
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
  if (!parsed.ok) {
    redirect(`/invoices/${invoiceId}?formError=${lineEditErrorCode(parsed.error)}`);
  }
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
      subtotal: true,
      vatAmount: true,
      total: true,
      // Reissue detection — non-null when this invoice was created via
      // reissueInvoiceAction. Drives the ledger post below.
      previousInvoiceId: true,
      // Phase 2: publicToken is the customer URL segment (see below).
      publicToken: true,
      // Line items — rendered in the WhatsApp body as "qty × description"
      // to match the supplier PO message shape (AR, 2026-08-10).
      lines: {
        select: { qty: true, description: true },
        orderBy: { createdAt: "asc" },
      },
      // Garage name goes into the message header line
      // ("Tax Invoice INV-… — from {garage name}").
      garage: { select: { name: true } },
      // JobCard number for the "JC-N" tail on the vehicle line, plus
      // the full vehicle snapshot (year/plate/VIN/engine/fuel) that
      // the new structured header renders.
      jobCard: {
        select: {
          number: true,
          vehicle: {
            select: {
              make: true,
              model: true,
              year: true,
              plate: true,
              vin: true,
              engineSize: true,
              fuelType: true,
              customer: {
                // id added AR 2026-08-19 so resolveCustomerLangForOutbound
                // has the FK to detect from message history.
                select: { id: true, name: true, phone: true, waId: true, lang: true },
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
  // fall back to `phone`. Bad phone no longer throws (AR, 2026-08-11) —
  // buildWaMeUrl falls back to the contact-picker URL so the cashier
  // can still send the invoice, they just pick the recipient inside
  // WhatsApp. The customer-record cleanup happens as its own concern.
  //
  // DELIBERATE DIVERGENCE from sendPurchaseOrderWhatsAppAction
  // (src/app/actions/purchasing.ts). AR 2026-08-23 — do NOT unify.
  // The customer flow chooses hand-off + a soft nudge (see the
  // preview-page banner) over blocking on bad data; the supplier
  // flow bounces because a PO to nobody is useless. Aligning them
  // (either direction) trades one bad UX for another. See the
  // sibling comment in sendEstimateToCustomerAction above.
  const rawPhone = customer.waId ?? customer.phone;
  const phoneE164 = normalizeToE164(rawPhone);

  // Phase 2 (2026-08-10): raw publicToken in the URL, not an HMAC of
  // inv.id. ensurePublicToken is a no-op when the row already carries
  // one (Phase-1 backfill covered every existing row); it generates
  // for rows created between backfill and this deploy. The
  // `invoiceMessage` builder's field is still named `invoiceId` for
  // now — it's the URL segment, whatever shape.
  // AR 2026-08-19 — detect from the customer's latest inbound
  // instead of trusting customer.lang. Same rationale as the
  // estimate send path just above.
  const detectedLang = await resolveCustomerLangForOutbound(customer.id, user.garageId);
  const publicToken = await ensurePublicToken("invoice", inv);
  const body = invoiceMessage({
    customer: { name: customer.name, lang: detectedLang },
    garage: { name: inv.garage.name },
    vehicle: {
      make: inv.jobCard.vehicle.make,
      model: inv.jobCard.vehicle.model,
      year: inv.jobCard.vehicle.year ?? null,
      plate: inv.jobCard.vehicle.plate ?? null,
      vin: inv.jobCard.vehicle.vin ?? null,
      engineSize: inv.jobCard.vehicle.engineSize ?? null,
      fuelType: inv.jobCard.vehicle.fuelType ?? null,
      jobNumber: inv.jobCard.number ?? null,
    },
    invoice: {
      number: formatInvoiceNo(inv.number, inv.issuedAt.getFullYear()),
      subtotal: Number(inv.subtotal),
      vatAmount: Number(inv.vatAmount),
      total: Number(inv.total),
      lines: inv.lines.map((l) => ({
        qty: Number(l.qty),
        description: l.description,
      })),
    },
    appUrl: appUrl(),
    invoiceId: publicToken,
  });
  const waHref = buildWaMeUrl(phoneE164, body);

  // Stamp the "handed off" timestamp + flip the row out of the
  // dashboard "To send" bucket in the same transaction. Once the Meta
  // Cloud API commit lands this becomes "sent" outright; today it's
  // an operator-hand-off stamp and every read site is reworded to
  // match.
  //
  // Reissue ledger post (AR 2026-08-17). Reissued invoices are
  // created as DRAFT by reissueInvoiceAction with NO ledger entries —
  // the deliberate choice was to defer until they're actually sent so
  // mid-draft edits don't need to re-post. First send is that
  // trigger: check `previousInvoiceId IS NOT NULL` and no existing
  // sourceType='INVOICE' rows for this invoice.id, then post the
  // standard invoiceLedger. Idempotent — a Resend from the send-
  // history page finds ledger rows already present and skips.
  // Originals (previousInvoiceId IS NULL) already posted their
  // ledger at generation time, so they always skip.
  await prisma.$transaction(async (tx) => {
    await tx.jobCard.update({
      where: { id: inv.jobCardId },
      data: { invoiceSentAt: new Date() },
    });
    if (inv.previousInvoiceId) {
      const alreadyPosted = await tx.ledgerEntry.count({
        where: { sourceType: "INVOICE", sourceId: inv.id },
      });
      if (alreadyPosted === 0) {
        await tx.ledgerEntry.createMany({
          data: invoiceLedger(
            Number(inv.subtotal),
            Number(inv.vatAmount),
            Number(inv.total),
          ).map((e) => ({
            garageId: user.garageId,
            account: e.account,
            debit: e.debit,
            credit: e.credit,
            sourceType: "INVOICE",
            sourceId: inv.id,
          })),
        });
      }
    }
  });

  // Sender name snapshot — the JWT's `name` field, else email. Frozen
  // on the audit row so a rename or offboarding can't rewrite who
  // handed the invoice off.
  const senderName = user.name?.trim() || user.email || "unknown";
  await logInvoiceSend({
    invoiceId: inv.id,
    garageId: user.garageId,
    channel: "WHATSAPP",
    // Recipient snapshot: the normalized E.164 when the phone was
    // valid, else the raw stored value, else the picker marker.
    // The audit row's job is "who did we tell WhatsApp to open" —
    // for the picker path we didn't tell it anyone, so record that.
    recipient: phoneE164 ?? rawPhone ?? "(picker)",
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
    // Phase 2: publicToken needed to build the customer URL.
    select: { id: true, jobCardId: true, number: true, issuedAt: true, publicToken: true },
  });
  if (!inv) throw new Error("Invoice not found in this garage");

  const customer = await customerForJob(inv.jobCardId, user.garageId);
  if (!customer) throw new Error("Customer not found for this invoice");
  if (!customer.email) {
    throw new Error("Customer has no email on file");
  }

  // Mock — no SMTP yet. See action doc-comment above.
  const publicToken = await ensurePublicToken("invoice", inv);
  console.log(
    `[mock-email] would send invoice ${inv.number} to ${customer.email} — ${appUrl()}/c/invoice/${publicToken}`,
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
    // AR 2026-08-20: paymentLedger's sourceId now points at the
    // Payment row (payment.id), not the parent Invoice. The previous
    // shape (sourceId = inv.id) was a bug present since the first
    // commit of billing.ts (98e0402, 2026-05) — every paymentLedger
    // row across prod carried an Invoice id under sourceType='PAYMENT',
    // which made every row look orphan to any join on the Payment
    // table. cleanup-orphan-ledger.mts wiped the whole subledger on
    // 2026-08-20 as a result. Fixing the writer stops the next
    // cleanup from re-wiping. Capture the created Payment's id via
    // `select` so the sourceId is available before ledger insertion.
    // paymentLedger and cleanup-orphan-ledger.mts are now internally
    // consistent: writer uses payment.id, cleanup joins on payment.id,
    // the trigger fires on Payment DELETE regardless.
    const payment = await tx.payment.create({
      data: { invoiceId: inv.id, amount, method },
      select: { id: true },
    });
    await tx.ledgerEntry.createMany({
      data: paymentLedger(amount).map((e) => ({
        garageId: user.garageId,
        account: e.account,
        debit: e.debit,
        credit: e.credit,
        sourceType: "PAYMENT",
        sourceId: payment.id,
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
 *
 * Ledger reversal (AR 2026-08-17). The original issuance posted
 *   DR AR (total) / CR Sales (subtotal) / CR VAT Payable (vatAmount)
 * with sourceType='INVOICE'. Voiding writes the exact mirror
 *   CR AR (total) / DR Sales (subtotal) / DR VAT Payable (vatAmount)
 * with sourceType='INVOICE_VOID', sourceId=this invoice, in the SAME
 * transaction as the status flip. Net across the two events on every
 * account is zero — the pure-function invariant is pinned by test.
 * Without this, AR/Sales/VAT Payable stayed overstated on the books
 * indefinitely (the shop appeared to owe FTA money for a voided
 * sale). PAID stays blocked — a paid invoice needs a credit note,
 * inventing a void-with-refund shape would make the accounting
 * worse. That gap ships separately.
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
      // Widened for the reversal: the reversing entries need the
      // exact numbers the original issuance posted.
      subtotal: true,
      vatAmount: true,
      total: true,
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

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: inv.id },
      data: {
        status: "VOID",
        voidedAt: new Date(),
        voidedByUserId: user.id,
      },
    });
    await tx.ledgerEntry.createMany({
      data: voidReversalLedger(
        Number(inv.subtotal),
        Number(inv.vatAmount),
        Number(inv.total),
      ).map((e) => ({
        garageId: user.garageId,
        account: e.account,
        debit: e.debit,
        credit: e.credit,
        sourceType: "INVOICE_VOID",
        sourceId: inv.id,
      })),
    });
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
      select: { invoiceSeq: true, name: true, trn: true, phone: true },
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
        publicToken: newPublicToken(),
        // DRAFT so the cashier can adjust before sending — the whole
        // point of reissue is that the void was wrong.
        status: "DRAFT",
        clearanceStatus: strategy.clearanceStatus,
        // AR 2026-08-25 — carry parity blocks forward. The reissue is
        // conceptually the same document; the customer read the void
        // with these remarks + terms + advisor, and the correction
        // shouldn't lose that context. Cashier can edit remarks +
        // paymentTerms on the DRAFT if the wording needs changing.
        remarks: voided.remarks,
        paymentTerms: voided.paymentTerms,
        advisorNameSnapshot: voided.advisorNameSnapshot,
        advisorPhoneSnapshot: voided.advisorPhoneSnapshot,
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

    // NOTE: no ledger rows written here. The reissue opens as DRAFT
    // and its totals may change before send — invoiceLedger is posted
    // by sendInvoiceToCustomerAction on the FIRST send (guarded by
    // previousInvoiceId IS NOT NULL + zero existing INVOICE rows for
    // this id, so re-sends don't double-post). The paired reversal
    // for the void itself is written by voidInvoiceAction with
    // sourceType='INVOICE_VOID', so the books are already balanced
    // by the time the operator opens the reissue for editing.

    return inv.id;
  });

  revalidatePath(`/invoices/${voidedId}`);
  revalidatePath(`/invoices/${newInvoiceId}`);
  revalidatePath("/cashier");
  redirect(`/invoices/${newInvoiceId}`);
}

/**
 * updateEstimateHeaderAction — sets Estimate.remarks and
 * Estimate.paymentTerms (AR 2026-08-25 Batch C).
 *
 * Writes ONLY the two header fields. Does not touch lines / totals /
 * status / ledger. Empty strings clear the field to null (matches how
 * defaultPaymentTerms clears on the settings action). The advisor
 * edits both fields on the estimate detail page; they surface on the
 * customer-facing preview + printable copy.
 *
 * Guard: ESTIMATE_CREATE_ROLES (advisor + owner + master) — the same
 * gate that admits the line-editing surface. Garage scope via
 * Estimate.jobCard.garageId.
 */
export async function updateEstimateHeaderAction(formData: FormData) {
  const user = await requireAnyRole(ESTIMATE_CREATE_ROLES);
  const estimateId = String(formData.get("estimateId") ?? "");
  const rawRemarks = String(formData.get("remarks") ?? "").trim();
  const rawTerms = String(formData.get("paymentTerms") ?? "").trim();

  // Garage-scope by joining through jobCard — Estimate has no
  // garageId column. Same pattern as sendEstimateToCustomerAction.
  const est = await prisma.estimate.findFirst({
    where: { id: estimateId, jobCard: { garageId: user.garageId } },
    select: { id: true },
  });
  if (!est) throw new Error("Estimate not found in this garage");

  await prisma.estimate.update({
    where: { id: est.id },
    data: {
      remarks: rawRemarks === "" ? null : rawRemarks,
      paymentTerms: rawTerms === "" ? null : rawTerms,
    },
  });
  revalidatePath(`/estimates/${estimateId}`);
  revalidatePath(`/estimates/${estimateId}/preview`);
}

/**
 * updateInvoiceHeaderAction — mirror of updateEstimateHeaderAction
 * for the invoice's parity blocks (AR 2026-08-25). Sets
 * Invoice.remarks and Invoice.paymentTerms only.
 *
 * The cashier occasionally needs to change wording at billing time
 * — a deposit was taken, a customer negotiated a different payment
 * split at collection, remarks need adjusting for the final scope.
 * Same principle as the estimate editor: two-field, single-purpose,
 * never touches lines / totals / status / ledger.
 *
 * Guard: canEditInvoice (cashier + owner + master). Garage scope
 * via Invoice.garageId directly. Does NOT gate on
 * invoiceDeliveredAt — remarks + payment terms are display metadata,
 * not accounting facts; the customer already has their copy but
 * fixing wording on the shop's record of the invoice is
 * uncontentious. If we later find shops using this to re-print a
 * changed invoice for the customer after delivery, we tighten the
 * gate then.
 */
export async function updateInvoiceHeaderAction(formData: FormData) {
  const user = await requireAnyRole(INVOICE_ROLES);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const rawRemarks = String(formData.get("remarks") ?? "").trim();
  const rawTerms = String(formData.get("paymentTerms") ?? "").trim();

  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, garageId: user.garageId },
    select: { id: true },
  });
  if (!inv) throw new Error("Invoice not found in this garage");

  await prisma.invoice.update({
    where: { id: inv.id },
    data: {
      remarks: rawRemarks === "" ? null : rawRemarks,
      paymentTerms: rawTerms === "" ? null : rawTerms,
    },
  });
  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath(`/invoices/${invoiceId}/preview`);
}
