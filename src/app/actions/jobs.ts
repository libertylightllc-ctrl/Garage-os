"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { transition, type JobAction, type JobStatus } from "@/lib/jobcard-status";

async function requireAdvisor() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADVISOR") {
    throw new Error("Not authorized");
  }
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

  const job = await prisma.jobCard.create({
    data: {
      garageId: user.garageId,
      vehicleId: vehicle.id,
      advisorId: user.id,
      status: "ARRIVED",
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

  await prisma.jobCard.update({
    where: { id: job.id },
    data: { status: next.status, heldFrom: next.heldFrom },
  });

  revalidatePath(`/advisor/jobs/${job.id}`);
  revalidatePath("/advisor");
}
