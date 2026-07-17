"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  inStock,
  shouldPauseForRequest,
  canTransition,
  stockDelta,
  canResumeFromParts,
  type PartRequestStatus,
} from "@/lib/partrequest";
import { PART_REQUEST_OPEN_STATUSES } from "@/lib/part-request-open";
import { canLogWork } from "@/lib/claim";
import { requireAnyRole, requireTech } from "@/lib/action-guards";


// Stages a job may be auto-paused from (linear, non-terminal, not already held).
function isPausable(status: string): boolean {
  return status !== "ON_HOLD" && status !== "CANCELLED" && status !== "DELIVERED";
}

/**
 * After a request closes, resume the job if it was held only for parts and there
 * are no more open requests. Never overrides an AWAITING_APPROVAL hold.
 *
 * Defense-in-depth: takes garageId so the read can't reach into another
 * garage even if a caller ever passed an unverified jobCardId. Every
 * existing caller already verifies the partRequest before calling, so
 * this is a no-op for current flows.
 */
async function maybeResumeJob(jobCardId: string, garageId: string) {
  const job = await prisma.jobCard.findFirst({
    where: { id: jobCardId, garageId },
    select: { id: true, status: true, holdReason: true, heldFrom: true },
  });
  if (!job) return;
  // Auto-resume gate: "any part still outstanding on this job?" A literal
  // status array here was a real hazard — if a new enum value (e.g.
  // BACKORDERED) shipped later, this count would treat it as CLOSED and
  // the job would auto-resume with parts still outstanding. Sourced from
  // the same exhaustive helper the queue page + nav badges use so all
  // three surfaces agree on what "OPEN" means.
  const openCount = await prisma.partRequest.count({
    where: {
      jobCardId,
      status: { in: [...PART_REQUEST_OPEN_STATUSES] },
    },
  });
  if (job.status === "ON_HOLD" && canResumeFromParts(job.holdReason, openCount)) {
    await prisma.jobCard.update({
      where: { id: job.id },
      data: { status: job.heldFrom ?? "REPAIR", heldFrom: null, holdReason: null, holdNote: null },
    });
  }
}

// ---------- Technician: request a part ----------
export async function requestPartAction(formData: FormData) {
  const user = await requireTech();

  const jobId = String(formData.get("jobId") ?? "");
  const partId = String(formData.get("partId") ?? "").trim() || null;
  const freeText = String(formData.get("description") ?? "").trim();
  const qty = Math.max(1, Math.floor(Number(formData.get("qty") ?? 1)));

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: {
      id: true,
      claimedById: true,
      status: true,
      holdReason: true,
      helpers: { select: { techId: true } },
    },
  });
  if (!job) throw new Error("Job not found in this garage");

  if (job.status === "TECH_COMPLETE" || job.status === "INVOICED" || job.status === "DELIVERED" || job.status === "CANCELLED") {
    throw new Error("This job is no longer open for work.");
  }
  if (job.status === "ON_HOLD" && job.holdReason === "AWAITING_APPROVAL") {
    throw new Error("Waiting for customer approval before any further work.");
  }
  if (!canLogWork(job, user.id, job.helpers.map((h) => h.techId))) {
    throw new Error("This car is being handled by another technician.");
  }
  if (!job.claimedById) {
    await prisma.jobCard.updateMany({
      where: { id: job.id, claimedById: null },
      data: { claimedById: user.id, claimedAt: new Date() },
    });
  }

  // Resolve the catalog part (if any) and decide availability.
  const part = partId
    ? await prisma.part.findFirst({ where: { id: partId, garageId: user.garageId } })
    : null;
  const description = part ? `${part.name} (${part.sku})` : freeText || "Part";
  const available = part ? inStock(part.qtyOnHand, qty) : false;

  await prisma.partRequest.create({
    data: {
      garageId: user.garageId,
      jobCardId: job.id,
      partId: part?.id ?? null,
      description,
      qty,
      status: "REQUESTED",
      requestedById: user.id,
    },
  });

  // Note: do NOT also write a JobPart REQUIRED here. An earlier slice
  // (e3a0918) tried to surface the requested part in the tech's
  // diagnosis Parts-required table, but it created duplicate rows in
  // jobs where the tech had ALSO typed the same part into the Add-part
  // form during diagnosis. The duplicates showed up on the cashier's
  // "Technician findings & parts required" panel as ghost AED-0 lines.
  // The PartRequest is the canonical record for the fulfillment loop;
  // the diagnosis-phase Add-part form is the canonical record for the
  // Parts-required table. Keep them independent.

  // Activity log entry so the request shows on the job timeline too.
  await prisma.jobStep.create({
    data: {
      jobCardId: job.id,
      type: "PART_REQUEST",
      techId: user.id,
      transcript: `Requested ${qty}× ${description}${available ? " (in stock)" : " (out of stock)"}`,
    },
  });

  // Out of stock → auto-pause "waiting for part".
  if (shouldPauseForRequest(available) && isPausable(job.status)) {
    await prisma.jobCard.update({
      where: { id: job.id },
      data: { status: "ON_HOLD", heldFrom: job.status as never, holdReason: "AWAITING_PART" },
    });
  }

  revalidatePath(`/technician/jobs/${job.id}`);
  revalidatePath(`/advisor/jobs/${job.id}`);
  revalidatePath("/advisor/parts");
}

// ---------- Advisor / parts person: move a request along ----------
async function advanceRequest(formData: FormData, to: PartRequestStatus, note?: string) {
  const user = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const requestId = String(formData.get("requestId") ?? "");

  const req = await prisma.partRequest.findFirst({
    where: { id: requestId, garageId: user.garageId },
    include: { part: true },
  });
  if (!req) throw new Error("Part request not found");
  if (!canTransition(req.status as PartRequestStatus, to)) {
    throw new Error(`Cannot move a ${req.status} request to ${to}`);
  }

  await prisma.$transaction(async (tx) => {
    // Atomic claim: the transition only applies if the request is STILL in the
    // status we read above. A concurrent duplicate (double-click, two tabs)
    // matches 0 rows and fails cleanly instead of applying stock effects twice.
    const claimed = await tx.partRequest.updateMany({
      where: { id: req.id, status: req.status },
      data: { status: to, note: note ?? req.note },
    });
    if (claimed.count === 0) {
      throw new Error("This request was already updated — refresh to see its current state.");
    }

    // Stock effects (catalog parts only): arrival adds, fulfilment consumes, a
    // wrong/late arrived part returned for re-order reverses the receipt.
    if (req.partId) {
      const delta = stockDelta(req.status as PartRequestStatus, to, req.qty);
      if (delta < 0) {
        // Consuming stock: conditional decrement so qtyOnHand can never go
        // below zero, even under concurrency (same guard as PO receive/return).
        const dec = await tx.part.updateMany({
          where: { id: req.partId, qtyOnHand: { gte: -delta } },
          data: { qtyOnHand: { increment: delta } },
        });
        if (dec.count === 0) {
          const p = await tx.part.findUnique({ where: { id: req.partId }, select: { qtyOnHand: true } });
          throw new Error(
            `Not enough stock: this needs ${-delta}, only ${p?.qtyOnHand ?? 0} on hand. Adjust stock or order the part first.`,
          );
        }
      } else if (delta > 0) {
        await tx.part.update({
          where: { id: req.partId },
          data: { qtyOnHand: { increment: delta } },
        });
      }
      if (delta !== 0) {
        const reason =
          to === "ARRIVED" ? "Part order received" : to === "FULFILLED" ? "Used on job" : "Wrong/late part returned";
        await tx.partMovement.create({
          data: { partId: req.partId, jobCardId: req.jobCardId, delta, reason },
        });
      }
    }
  });

  // If ordering an in-stock-or-not request, make sure the job is paused for parts.
  if (to === "ORDERED") {
    // Defense-in-depth: scope by user.garageId — req was already verified
    // via the findFirst at the top of this action.
    const job = await prisma.jobCard.findFirst({
      where: { id: req.jobCardId, garageId: user.garageId },
      select: { status: true },
    });
    if (job && isPausable(job.status)) {
      await prisma.jobCard.update({
        where: { id: req.jobCardId },
        data: { status: "ON_HOLD", heldFrom: job.status as never, holdReason: "AWAITING_PART" },
      });
    }
  }

  // Closing a request may release the job.
  await maybeResumeJob(req.jobCardId, user.garageId);

  revalidatePath("/advisor/parts");
  revalidatePath(`/advisor/jobs/${req.jobCardId}`);
  revalidatePath(`/technician/jobs/${req.jobCardId}`);
}

export async function orderPartRequestAction(formData: FormData) {
  const note = String(formData.get("note") ?? "").trim() || undefined;
  await advanceRequest(formData, "ORDERED", note);
}

export async function arrivePartRequestAction(formData: FormData) {
  await advanceRequest(formData, "ARRIVED");
}

export async function fulfillPartRequestAction(formData: FormData) {
  await advanceRequest(formData, "FULFILLED");
}

export async function cancelPartRequestAction(formData: FormData) {
  await advanceRequest(formData, "CANCELLED");
}

/**
 * Technician undo for a part request they submitted by mistake. Strictly
 * narrower than the advisor / owner cancelPartRequestAction:
 *   - Only the TECH who originally requested it may cancel.
 *   - Only while the request is still REQUESTED (untouched by parts).
 *     Once it's ORDERED / ARRIVED / FULFILLED the cashier/advisor has
 *     already actioned it (or stock has moved) — the tech must escalate
 *     to the advisor's queue rather than silently undoing real work.
 *
 * The PartRequest row is NOT hard-deleted. It flips to CANCELLED so the
 * audit trail stays intact, and a JobStep PART_REQUEST entry records
 * who cancelled it. maybeResumeJob() runs in case the job was on hold
 * waiting for this part — same release path the advisor cancel uses.
 */
export async function cancelOwnPartRequestAction(formData: FormData) {
  const user = await requireTech();

  const requestId = String(formData.get("requestId") ?? "");
  const req = await prisma.partRequest.findFirst({
    where: { id: requestId, garageId: user.garageId },
    select: {
      id: true,
      jobCardId: true,
      status: true,
      qty: true,
      description: true,
      requestedById: true,
    },
  });
  if (!req) throw new Error("Part request not found in this garage");
  // Ownership gate — tech may only cancel their own requests. Another
  // tech on the same job (e.g. a helper) cannot undo someone else's
  // mistake; that escalates to the advisor as before.
  if (req.requestedById !== user.id) {
    throw new Error("You can only cancel your own part requests.");
  }
  // State gate — once advisor / parts has moved it, the tech can't
  // silently roll it back. Hide-or-error: we error so a stale UI click
  // (the row's status changed after page load) doesn't quietly succeed.
  if (req.status !== "REQUESTED") {
    throw new Error("This request has already been actioned and can't be cancelled from here.");
  }

  await prisma.partRequest.update({
    where: { id: req.id },
    data: { status: "CANCELLED" },
  });
  await prisma.jobStep.create({
    data: {
      jobCardId: req.jobCardId,
      type: "PART_REQUEST",
      techId: user.id,
      transcript: `Part request cancelled — ${req.qty}× ${req.description}`,
    },
  });
  // If the job was paused specifically waiting for THIS part (and no
  // other open requests remain), the helper releases it. Same release
  // path the advisor cancel uses, so behaviour stays symmetric.
  await maybeResumeJob(req.jobCardId, user.garageId);

  revalidatePath(`/technician/jobs/${req.jobCardId}`);
  revalidatePath(`/advisor/jobs/${req.jobCardId}`);
  revalidatePath("/advisor/parts");
}
