"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { transition, skipTo, type JobAction, type JobStatus } from "@/lib/jobcard-status";
import { saveUpload } from "@/lib/storage";
import { sendWhatsApp, appUrl } from "@/lib/whatsapp";
import { signId } from "@/lib/tokens";

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
  revalidatePath("/technician");
  if (res.count === 0) redirect("/technician?taken=1"); // already taken / not eligible
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
  const photoUrl = await saveUpload(f);

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
