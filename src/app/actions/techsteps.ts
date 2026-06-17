"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { saveUpload } from "@/lib/storage";
import { canLogWork } from "@/lib/claim";

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

  let photoUrl: string | undefined;
  let voiceNoteUrl: string | undefined;
  let transcript: string | undefined;

  if (type === "PHOTO") {
    const f = formData.get("file");
    if (f instanceof File && f.size > 0) photoUrl = await saveUpload(f, user.garageId);
    else throw new Error("No photo selected");
  } else if (type === "VOICE") {
    // Voice notes are speech-to-text only now (matches the dictation
    // flow the tech already uses for findings). The legacy file-upload
    // path is removed — what arrives is a transcript string from
    // VoiceNoteDictation. A blank transcript is a user error, not a
    // 500 — surface it cleanly so the form doesn't disappear into a
    // generic crash.
    const t = String(formData.get("transcript") ?? "").trim();
    if (!t) throw new Error("Voice note is empty — say something or type a note.");
    transcript = t;
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
