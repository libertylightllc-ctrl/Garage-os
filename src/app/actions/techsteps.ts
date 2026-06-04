"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { saveUpload } from "@/lib/storage";

async function requireTech() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TECH") throw new Error("Not authorized");
  return session.user;
}

// Single action for all workshop buttons; the submit button's `type` value selects behavior.
export async function addStepAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const type = String(formData.get("type") ?? "");

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, claimedById: true, status: true, holdReason: true },
  });
  if (!job) throw new Error("Job not found in this garage");

  // No work while waiting for customer approval of a revised quote.
  if (job.status === "ON_HOLD" && job.holdReason === "AWAITING_APPROVAL") {
    throw new Error("Waiting for customer approval before any further work.");
  }

  // Only the claimer may log work; an unclaimed car is auto-claimed on first action.
  if (job.claimedById && job.claimedById !== user.id) {
    throw new Error("This car is being handled by another technician.");
  }
  if (!job.claimedById) {
    await prisma.jobCard.updateMany({
      where: { id: job.id, claimedById: null },
      data: { claimedById: user.id, claimedAt: new Date() },
    });
  }

  let photoUrl: string | undefined;
  let voiceNoteUrl: string | undefined;
  let transcript: string | undefined;

  if (type === "PHOTO") {
    const f = formData.get("file");
    if (f instanceof File && f.size > 0) photoUrl = await saveUpload(f);
    else throw new Error("No photo selected");
  } else if (type === "VOICE") {
    const f = formData.get("file");
    if (f instanceof File && f.size > 0) voiceNoteUrl = await saveUpload(f);
    else throw new Error("No voice note selected");
  } else if (type === "PART_REQUEST") {
    const partId = String(formData.get("partId") ?? "");
    const part = partId
      ? await prisma.part.findFirst({ where: { id: partId, garageId: user.garageId } })
      : null;
    transcript = part ? `Requested part: ${part.name} (${part.sku})` : "Requested a part";
    if (part) {
      await prisma.partMovement.create({
        data: { partId: part.id, jobCardId: job.id, delta: -1, reason: "Technician request" },
      });
    }
  } else if (type === "FINISH") {
    transcript = "Technician marked work finished";
  } else {
    throw new Error(`Unknown step type ${type}`);
  }

  await prisma.jobStep.create({
    data: { jobCardId: job.id, type, techId: user.id, photoUrl, voiceNoteUrl, transcript },
  });
  revalidatePath(`/technician/jobs/${job.id}`);
}
