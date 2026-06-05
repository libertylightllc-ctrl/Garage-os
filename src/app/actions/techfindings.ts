"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canLogWork } from "@/lib/claim";
import { canSubmitFindings, nextStatusAfterFindings, cleanQty } from "@/lib/jobfindings";
import { sanitizeChoices, QC_CHECKS } from "@/lib/jobcard-fields";

async function requireTech() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TECH") throw new Error("Not authorized");
  return session.user;
}

// Load a job the technician may work on (claimer or helper); auto-claims if in the pool.
async function workableJob(jobId: string, garageId: string, userId: string) {
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId },
    select: {
      id: true,
      status: true,
      claimedById: true,
      holdReason: true,
      workCompletedAt: true,
      qcAt: true,
      helpers: { select: { techId: true } },
      finding: { select: { submittedAt: true } },
    },
  });
  if (!job) throw new Error("Job not found in this garage");
  if (job.status === "ON_HOLD" && job.holdReason === "AWAITING_APPROVAL") {
    throw new Error("Waiting for customer approval before any further work.");
  }
  if (!canLogWork(job, userId, job.helpers.map((h) => h.techId))) {
    throw new Error("This car is being handled by another technician.");
  }
  if (!job.claimedById) {
    await prisma.jobCard.updateMany({
      where: { id: job.id, claimedById: null },
      data: { claimedById: userId, claimedAt: new Date() },
    });
  }
  return job;
}

function assertNotSubmitted(job: { finding: { submittedAt: Date | null } | null }) {
  if (job.finding?.submittedAt) throw new Error("Already submitted to the cashier.");
}

function assertRepairOpen(job: { workCompletedAt: Date | null }) {
  if (job.workCompletedAt) throw new Error("Work already marked complete.");
}

// Save the findings/diagnosis draft.
export async function saveFindingsAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const findings = String(formData.get("findings") ?? "").trim() || null;
  const diagnosis = String(formData.get("diagnosis") ?? "").trim() || null;

  const job = await workableJob(jobId, user.garageId, user.id);
  assertNotSubmitted(job);

  await prisma.jobFinding.upsert({
    where: { jobCardId: jobId },
    update: { findings, diagnosis, techId: user.id },
    create: { jobCardId: jobId, findings, diagnosis, techId: user.id },
  });
  revalidatePath(`/technician/jobs/${jobId}`);
}

// Add a required part line (catalog or free-text).
export async function addRequiredPartAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await workableJob(jobId, user.garageId, user.id);
  assertNotSubmitted(job);

  const partId = String(formData.get("partId") ?? "").trim() || null;
  let partNo = String(formData.get("partNo") ?? "").trim() || null;
  let description = String(formData.get("description") ?? "").trim();
  const qty = cleanQty(Number(formData.get("qty") ?? 1));

  if (partId) {
    const part = await prisma.part.findFirst({
      where: { id: partId, garageId: user.garageId },
      select: { sku: true, name: true },
    });
    if (part) {
      partNo = partNo || part.sku;
      description = description || part.name;
    }
  }
  if (!description) throw new Error("A part description is required.");

  await prisma.jobPart.create({
    data: {
      jobCardId: jobId,
      kind: "REQUIRED",
      partId,
      partNo,
      description,
      qty,
      createdById: user.id,
    },
  });
  revalidatePath(`/technician/jobs/${jobId}`);
}

export async function removeJobPartAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const partLineId = String(formData.get("partLineId") ?? "");
  const job = await workableJob(jobId, user.garageId, user.id);
  assertNotSubmitted(job);

  await prisma.jobPart.deleteMany({ where: { id: partLineId, jobCardId: jobId, kind: "REQUIRED" } });
  revalidatePath(`/technician/jobs/${jobId}`);
}

// Submit findings to the cashier: stamp the time + advance the job to ESTIMATE.
export async function submitFindingsAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await workableJob(jobId, user.garageId, user.id);

  const finding = await prisma.jobFinding.findUnique({
    where: { jobCardId: jobId },
    select: { findings: true, submittedAt: true },
  });
  if (finding?.submittedAt) return; // already handed off
  if (!canSubmitFindings(finding)) {
    throw new Error("Enter your findings before submitting to the cashier.");
  }

  await prisma.jobFinding.update({
    where: { jobCardId: jobId },
    data: { submittedAt: new Date() },
  });

  // Advance to ESTIMATE only from an early stage (advisor keeps timeline control).
  const next = nextStatusAfterFindings(job.status);
  if (next !== job.status) {
    await prisma.jobCard.updateMany({
      where: { id: jobId, status: { in: ["ARRIVED", "INSPECTION"] } },
      data: { status: next as never },
    });
  }

  revalidatePath(`/technician/jobs/${jobId}`);
  revalidatePath("/technician");
  revalidatePath("/advisor");
  revalidatePath(`/advisor/jobs/${jobId}`);
  revalidatePath("/cashier");
}

// ---------- Quality Control: checklist + sign-off ----------
export async function signOffQcAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await workableJob(jobId, user.garageId, user.id);
  if (!job.workCompletedAt) throw new Error("Mark the work complete before QC.");
  if (job.qcAt) return; // already signed off

  const qcChecks = sanitizeChoices(formData.getAll("qc").map(String), QC_CHECKS);
  await prisma.jobCard.update({
    where: { id: jobId },
    data: { qcChecks, qcById: user.id, qcAt: new Date() },
  });
  revalidatePath(`/technician/jobs/${jobId}`);
  revalidatePath("/advisor");
  revalidatePath(`/advisor/jobs/${jobId}`);
}

// ---------- Repair stage: work-completed notes + Parts Used ----------
export async function saveWorkNotesAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const workNotes = String(formData.get("workNotes") ?? "").trim() || null;
  const job = await workableJob(jobId, user.garageId, user.id);
  assertRepairOpen(job);
  await prisma.jobCard.update({ where: { id: jobId }, data: { workNotes } });
  revalidatePath(`/technician/jobs/${jobId}`);
}

export async function addUsedPartAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await workableJob(jobId, user.garageId, user.id);
  assertRepairOpen(job);

  const partId = String(formData.get("partId") ?? "").trim() || null;
  let partNo = String(formData.get("partNo") ?? "").trim() || null;
  let description = String(formData.get("description") ?? "").trim();
  const qty = cleanQty(Number(formData.get("qty") ?? 1));

  if (partId) {
    const part = await prisma.part.findFirst({
      where: { id: partId, garageId: user.garageId },
      select: { sku: true, name: true },
    });
    if (part) {
      partNo = partNo || part.sku;
      description = description || part.name;
    }
  }
  if (!description) throw new Error("A part description is required.");

  await prisma.jobPart.create({
    data: { jobCardId: jobId, kind: "USED", partId, partNo, description, qty, createdById: user.id },
  });
  revalidatePath(`/technician/jobs/${jobId}`);
}

export async function removeUsedPartAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const partLineId = String(formData.get("partLineId") ?? "");
  const job = await workableJob(jobId, user.garageId, user.id);
  assertRepairOpen(job);
  await prisma.jobPart.deleteMany({ where: { id: partLineId, jobCardId: jobId, kind: "USED" } });
  revalidatePath(`/technician/jobs/${jobId}`);
}

// Mark the work complete → stamp the time + lock the repair section. The cashier
// then finalises the invoice (Final Billing may differ from the estimate).
export async function markWorkCompleteAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await workableJob(jobId, user.garageId, user.id);
  if (job.workCompletedAt) return; // already complete

  await prisma.jobCard.update({ where: { id: jobId }, data: { workCompletedAt: new Date() } });
  await prisma.jobStep.create({
    data: { jobCardId: jobId, type: "FINISH", techId: user.id, transcript: "Work marked complete" },
  });

  revalidatePath(`/technician/jobs/${jobId}`);
  revalidatePath("/technician");
  revalidatePath("/advisor");
  revalidatePath(`/advisor/jobs/${jobId}`);
  revalidatePath("/cashier");
}
