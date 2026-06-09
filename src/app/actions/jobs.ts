"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { transition, skipTo, type JobAction, type JobStatus } from "@/lib/jobcard-status";
import { saveUpload } from "@/lib/storage";
import { sendWhatsApp, appUrl } from "@/lib/whatsapp";
import { signId } from "@/lib/tokens";
import { clampPriority } from "@/lib/priority";
import { canJoinAsHelper } from "@/lib/claim";

const HOLD_REASONS = ["AWAITING_PART", "AWAITING_CUSTOMER", "OTHER"] as const;

async function requireAdvisor() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADVISOR") {
    throw new Error("Not authorized");
  }
  return session.user;
}

async function requireTech() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TECH") throw new Error("Not authorized");
  return session.user;
}

export async function createJobCardAction(formData: FormData) {
  const user = await requireAdvisor();
  const vehicleId = String(formData.get("vehicleId") ?? "");

  // Tenant check: the vehicle's customer must belong to this advisor's garage.
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, customer: { garageId: user.garageId } },
    select: { id: true },
  });
  if (!vehicle) throw new Error("Vehicle not found in this garage");

  // Optional check-in assignment to a specific technician (else shared pool).
  const assignedToRaw = String(formData.get("assignedToId") ?? "");
  let assignedToId: string | null = null;
  if (assignedToRaw) {
    const tech = await prisma.user.findFirst({
      where: { id: assignedToRaw, garageId: user.garageId, role: "TECH" },
      select: { id: true },
    });
    assignedToId = tech?.id ?? null;
  }

  const job = await prisma.jobCard.create({
    data: {
      garageId: user.garageId,
      vehicleId: vehicle.id,
      advisorId: user.id,
      status: "ARRIVED",
      assignedToId,
    },
    select: { id: true },
  });

  revalidatePath("/advisor");
  redirect(`/advisor/jobs/${job.id}`);
}

export async function jobActionAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const action = String(formData.get("action") ?? "") as JobAction;

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, status: true, heldFrom: true },
  });
  if (!job) throw new Error("Job not found in this garage");

  const next = transition(
    { status: job.status as JobStatus, heldFrom: (job.heldFrom ?? null) as JobStatus | null },
    action,
  );

  // Capture/clear the hold reason alongside the status change.
  let holdReason: (typeof HOLD_REASONS)[number] | null = null;
  let holdNote: string | null = null;
  if (action === "HOLD") {
    const r = String(formData.get("holdReason") ?? "OTHER");
    holdReason = (HOLD_REASONS as readonly string[]).includes(r)
      ? (r as (typeof HOLD_REASONS)[number])
      : "OTHER";
    holdNote = String(formData.get("holdNote") ?? "").trim() || null;
  }

  await prisma.jobCard.update({
    where: { id: job.id },
    data: { status: next.status, heldFrom: next.heldFrom, holdReason, holdNote },
  });

  revalidatePath(`/advisor/jobs/${job.id}`);
  revalidatePath("/advisor");
}

// Atomic claim: a single conditional UPDATE (compare-and-set). Two simultaneous claims
// are serialized by the row lock — only the one matching `claimedById: null` writes; the
// loser's WHERE matches 0 rows (count 0). No read-then-write, so no double-assignment.
export async function claimJobAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  // Two-step: claim atomically, then if the claim landed and the job was
  // still at ARRIVED, promote it to INSPECTION so the friendly status
  // changes from 'Waiting for technician' to 'Technician diagnosing' the
  // moment the tech tap-claims it. updateMany with status guard means we
  // never overwrite a hand-set ON_HOLD / ESTIMATE / etc.
  const res = await prisma.jobCard.updateMany({
    where: {
      id: jobId,
      garageId: user.garageId,
      claimedById: null, // the guard
      status: { notIn: ["DELIVERED", "CANCELLED"] },
      OR: [{ assignedToId: null }, { assignedToId: user.id }],
    },
    data: { claimedById: user.id, claimedAt: new Date() },
  });
  if (res.count > 0) {
    await prisma.jobCard.updateMany({
      where: { id: jobId, garageId: user.garageId, status: "ARRIVED" },
      data: { status: "INSPECTION" },
    });
  }
  revalidatePath("/technician");
  revalidatePath("/advisor");
  if (res.count === 0) redirect("/technician?taken=1"); // already taken / not eligible
}

/**
 * Stage 7→8 — Tech taps 'Mark complete' after the approved work is done.
 * Stamps completedAt (workCompletedAt in the schema) and flips status to
 * TECH_COMPLETE, putting the job on the cashier's queue to finalise the
 * invoice. Only the claimer (or a helper joined on the job) can mark
 * complete; status must be APPROVED or REPAIR (the work-in-progress
 * window), otherwise we redirect with a soft error.
 */
export async function markCompleteAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: {
      id: true,
      status: true,
      claimedById: true,
      helpers: { where: { techId: user.id }, select: { techId: true } },
    },
  });
  if (!job) throw new Error("Job not found in this garage");
  const isPrimary = job.claimedById === user.id;
  const isHelper = job.helpers.length > 0;
  if (!isPrimary && !isHelper) {
    redirect(`/technician/jobs/${jobId}?error=notyours`);
  }
  // Stage 7 covers APPROVED (work just started) and REPAIR (actively
  // working). Anywhere else Mark-complete makes no sense.
  if (job.status !== "APPROVED" && job.status !== "REPAIR") {
    redirect(`/technician/jobs/${jobId}?error=cannotcomplete`);
  }
  await prisma.jobCard.update({
    where: { id: jobId },
    data: {
      status: "TECH_COMPLETE",
      workCompletedAt: new Date(),
      heldFrom: null,
      holdReason: null,
      holdNote: null,
    },
  });
  revalidatePath("/technician");
  revalidatePath("/cashier");
  revalidatePath("/advisor");
  revalidatePath(`/advisor/jobs/${jobId}`);
  redirect(`/technician/jobs/${jobId}/marked-complete`);
}

/**
 * Tech taps 'Send for Estimate' on a job they're working on. Moves the
 * job to ESTIMATE status so it appears in the cashier's pricing queue,
 * and shows a confirmation screen so the tech knows the handoff happened.
 * The tech keeps the claim — it stays 'their' job, just now the cashier
 * has to set the price before any further work can happen.
 */
export async function sendForEstimateAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, status: true, claimedById: true },
  });
  if (!job) throw new Error("Job not found in this garage");
  // Only the tech who claimed it (or a helper) can send to cashier — we
  // check claimedById here; helpers are handled in the UI gate.
  if (job.claimedById !== user.id) {
    // Helper / unclaimed → reject by redirect, keep server-side simple.
    redirect(`/technician/jobs/${jobId}?error=notyours`);
  }
  // Only meaningful to send when we're in a pre-estimate stage. From
  // ESTIMATE / APPROVED / REPAIR / INVOICED / DELIVERED / CANCELLED a
  // resend would skip steps; force-redirect with a soft error.
  const sendable: string[] = ["ARRIVED", "INSPECTION", "ON_HOLD"];
  if (!sendable.includes(job.status)) {
    redirect(`/technician/jobs/${jobId}?error=alreadysent`);
  }
  await prisma.jobCard.update({
    where: { id: jobId },
    data: {
      status: "ESTIMATE",
      // Time-tracking: end of the diagnosis window, start of the pricing
      // window. Read on all three dashboards to show 'Diagnosis: 12m'.
      sentForEstimateAt: new Date(),
      heldFrom: null,
      holdReason: null,
      holdNote: null,
    },
  });
  revalidatePath("/technician");
  revalidatePath("/cashier");
  revalidatePath("/advisor");
  revalidatePath(`/advisor/jobs/${jobId}`);
  redirect(`/technician/jobs/${jobId}/sent-to-cashier`);
}

// Tier 2 #4 — a second technician joins a claimed car as a helper.
export async function joinJobAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, status: true, claimedById: true, helpers: { select: { techId: true } } },
  });
  if (!job) throw new Error("Job not found in this garage");
  const helperIds = job.helpers.map((h) => h.techId);
  if (!canJoinAsHelper(job, user.id, helperIds)) {
    redirect("/technician?taken=1");
  }
  await prisma.jobHelper.create({ data: { jobCardId: job.id, techId: user.id } });
  revalidatePath("/technician");
  revalidatePath(`/technician/jobs/${job.id}`);
}

export async function leaveHelperAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  await prisma.jobHelper.deleteMany({ where: { jobCardId: jobId, techId: user.id } });
  revalidatePath("/technician");
  revalidatePath(`/technician/jobs/${jobId}`);
}

// Tier 2 #7 — advisor assigns (or clears) the bay/ramp a car occupies.
export async function setBayAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const bayRaw = String(formData.get("bayId") ?? "");
  let bayId: string | null = null;
  if (bayRaw) {
    const bay = await prisma.bay.findFirst({
      where: { id: bayRaw, garageId: user.garageId },
      select: { id: true },
    });
    bayId = bay?.id ?? null;
  }
  await prisma.jobCard.updateMany({ where: { id: jobId, garageId: user.garageId }, data: { bayId } });
  revalidatePath(`/advisor/jobs/${jobId}`);
  revalidatePath("/advisor");
}

export async function releaseJobAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  await prisma.jobCard.updateMany({
    where: { id: jobId, claimedById: user.id }, // only the claimer can release
    data: { claimedById: null, claimedAt: null },
  });
  revalidatePath("/technician");
}

// Advisor (re)assigns a car to a tech (or back to the shared pool). Clears any existing
// claim so the newly-assigned tech can pick it up from their Waiting list.
export async function reassignJobAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const raw = String(formData.get("assignedToId") ?? "");

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true },
  });
  if (!job) throw new Error("Job not found in this garage");

  let assignedToId: string | null = null;
  if (raw) {
    const tech = await prisma.user.findFirst({
      where: { id: raw, garageId: user.garageId, role: "TECH" },
      select: { id: true },
    });
    assignedToId = tech?.id ?? null;
  }

  await prisma.jobCard.update({
    where: { id: job.id },
    data: { assignedToId, claimedById: null, claimedAt: null },
  });
  revalidatePath(`/advisor/jobs/${job.id}`);
  revalidatePath("/advisor");
  revalidatePath("/technician");
}

// Tier 3 #11 — check-in photo prompt (dispute shield). The advisor photographs the
// car at intake; reuses the existing JobStep PHOTO feed (techId null = advisor).
export async function checkInPhotoAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await jobInGarage(jobId, user.garageId);

  const f = formData.get("file");
  if (!(f instanceof File) || f.size === 0) throw new Error("No photo selected");
  const photoUrl = await saveUpload(f, user.garageId);

  await prisma.jobStep.create({
    data: { jobCardId: job.id, type: "PHOTO", transcript: "Check-in photo", photoUrl },
  });
  revalidatePath(`/advisor/jobs/${job.id}`);
}

async function jobInGarage(jobId: string, garageId: string) {
  const job = await prisma.jobCard.findFirst({ where: { id: jobId, garageId }, select: { id: true } });
  if (!job) throw new Error("Job not found in this garage");
  return job;
}

// Tier 2 #9 — nudge a customer whose car is ready but not collected (WhatsApp).
export async function nudgeCollectionAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    include: { vehicle: { include: { customer: true } }, invoices: { select: { id: true }, take: 1 } },
  });
  if (!job) throw new Error("Job not found in this garage");

  const customer = job.vehicle.customer;
  const invId = job.invoices[0]?.id;
  const link = invId ? ` ${appUrl()}/c/invoice/${signId("invoice", invId)}` : "";
  await sendWhatsApp({
    garageId: user.garageId,
    customerId: customer.id,
    waId: customer.waId ?? customer.phone,
    template: "ready_for_collection",
    body: `Your ${job.vehicle.make} ${job.vehicle.model} is ready for collection.${link}`,
  });
  revalidatePath("/advisor/eod");
}

// Tier 2 #6 — bump a car's queue priority (VIP / emergency / fleet).
export async function setPriorityAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const priority = clampPriority(Number(formData.get("priority") ?? 0));
  await prisma.jobCard.updateMany({
    where: { id: jobId, garageId: user.garageId },
    data: { priority },
  });
  revalidatePath(`/advisor/jobs/${jobId}`);
  revalidatePath("/advisor");
  revalidatePath("/technician");
}

export async function skipToStageAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const target = String(formData.get("target") ?? "") as JobStatus;

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, status: true, heldFrom: true },
  });
  if (!job) throw new Error("Job not found in this garage");

  const next = skipTo(
    { status: job.status as JobStatus, heldFrom: (job.heldFrom ?? null) as JobStatus | null },
    target,
  );
  await prisma.jobCard.update({
    where: { id: job.id },
    data: { status: next.status, heldFrom: next.heldFrom, holdReason: null, holdNote: null },
  });

  revalidatePath(`/advisor/jobs/${job.id}`);
  revalidatePath("/advisor");
}
