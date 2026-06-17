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
import { canLogWork } from "@/lib/claim";

async function requireRoleAny(roles: string[]) {
  const session = await auth();
  if (!session?.user || !roles.includes(session.user.role)) throw new Error("Not authorized");
  return session.user;
}

// Stages a job may be auto-paused from (linear, non-terminal, not already held).
function isPausable(status: string): boolean {
  return status !== "ON_HOLD" && status !== "CANCELLED" && status !== "DELIVERED";
}

/**
 * After a request closes, resume the job if it was held only for parts and there
 * are no more open requests. Never overrides an AWAITING_APPROVAL hold.
 */
async function maybeResumeJob(jobCardId: string) {
  const job = await prisma.jobCard.findUnique({
    where: { id: jobCardId },
    select: { id: true, status: true, holdReason: true, heldFrom: true },
  });
  if (!job) return;
  const openCount = await prisma.partRequest.count({
    where: { jobCardId, status: { in: ["REQUESTED", "ORDERED", "ARRIVED"] } },
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
  const session = await auth();
  if (!session?.user || session.user.role !== "TECH") throw new Error("Not authorized");
  const user = session.user;

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

  // No work while waiting for customer approval of a revised quote.
  if (job.status === "ON_HOLD" && job.holdReason === "AWAITING_APPROVAL") {
    throw new Error("Waiting for customer approval before any further work.");
  }
  // The primary claimer OR a helper may log work; an unclaimed car auto-claims.
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

  // Also surface the requested part in the technician's "Parts required"
  // table — same JobPart REQUIRED row that the Add-part form creates.
  // This means a tech who taps Request Part doesn't need to ALSO type
  // the part into the diagnosis list separately, and the vehicle
  // Make / Model / Year automatically show in the table (the table reads
  // job.vehicle for those columns, not the JobPart row itself). The
  // PartRequest record stays alongside so the advisor's parts queue +
  // out-of-stock auto-pause behaviour is unchanged.
  await prisma.jobPart.create({
    data: {
      jobCardId: job.id,
      kind: "REQUIRED",
      partId: part?.id ?? null,
      description,
      qty,
      createdById: user.id,
    },
  });

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
  const user = await requireRoleAny(["ADVISOR", "OWNER"]);
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
    await tx.partRequest.update({
      where: { id: req.id },
      data: { status: to, note: note ?? req.note },
    });

    // Stock effects (catalog parts only): arrival adds, fulfilment consumes, a
    // wrong/late arrived part returned for re-order reverses the receipt.
    if (req.partId) {
      const delta = stockDelta(req.status as PartRequestStatus, to, req.qty);
      if (delta !== 0) {
        await tx.part.update({
          where: { id: req.partId },
          data: { qtyOnHand: { increment: delta } },
        });
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
    const job = await prisma.jobCard.findUnique({
      where: { id: req.jobCardId },
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
  await maybeResumeJob(req.jobCardId);

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
