"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendWhatsApp } from "@/lib/whatsapp";
import { dueDateFor, reminderBody, REMINDER_TYPES, type ReminderType } from "@/lib/reminders";
import { requireAdvisor } from "@/lib/action-guards";

// ---------- Advisor: schedule reminders when a job completes ----------
export async function scheduleRemindersAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const types = formData
    .getAll("types")
    .map(String)
    .filter((t): t is ReminderType => (REMINDER_TYPES as string[]).includes(t));

  const dateRaw = String(formData.get("serviceDate") ?? "").trim();
  const serviceDate = dateRaw ? new Date(dateRaw) : new Date();

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, vehicleId: true },
  });
  if (!job) throw new Error("Job not found in this garage");
  if (types.length === 0) return;

  for (const type of types) {
    // Don't double-schedule the same service for this vehicle while one is pending.
    const existing = await prisma.reminder.findFirst({
      where: { vehicleId: job.vehicleId, type, status: "SCHEDULED" },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.reminder.create({
      data: {
        garageId: user.garageId,
        vehicleId: job.vehicleId,
        jobCardId: job.id,
        type,
        serviceDate,
        dueAt: dueDateFor(type, serviceDate),
        status: "SCHEDULED",
      },
    });
  }

  revalidatePath(`/advisor/jobs/${jobId}`);
  revalidatePath("/advisor/reminders");
}

// ---------- Send (routine → auto; recorded on send) ----------
async function sendOne(reminderId: string, garageId: string) {
  const r = await prisma.reminder.findFirst({
    where: { id: reminderId, garageId, status: "SCHEDULED" },
    include: { vehicle: { include: { customer: true } } },
  });
  if (!r) return false;

  const customer = r.vehicle.customer;
  const vehicleLabel = `${r.vehicle.make} ${r.vehicle.model}`;
  const lang = (customer.lang ?? "en") as "en" | "ar" | "hi" | "ur";
  const body = reminderBody(r.type as ReminderType, vehicleLabel, lang);

  await sendWhatsApp({
    garageId,
    customerId: customer.id,
    waId: customer.waId ?? customer.phone,
    template: "maintenance_reminder",
    body,
  });

  await prisma.reminder.update({
    where: { id: r.id },
    data: { status: "SENT", sentAt: new Date() },
  });
  return true;
}

export async function sendReminderAction(formData: FormData) {
  const user = await requireAdvisor();
  const reminderId = String(formData.get("reminderId") ?? "");
  await sendOne(reminderId, user.garageId);
  revalidatePath("/advisor/reminders");
}

/** Stand-in for a scheduled Cron: send every reminder that's due now. */
export async function sendDueRemindersAction() {
  const user = await requireAdvisor();
  const due = await prisma.reminder.findMany({
    where: { garageId: user.garageId, status: "SCHEDULED", dueAt: { lte: new Date() } },
    select: { id: true },
  });
  for (const d of due) await sendOne(d.id, user.garageId);
  revalidatePath("/advisor/reminders");
}

export async function cancelReminderAction(formData: FormData) {
  const user = await requireAdvisor();
  const reminderId = String(formData.get("reminderId") ?? "");
  await prisma.reminder.updateMany({
    where: { id: reminderId, garageId: user.garageId, status: "SCHEDULED" },
    data: { status: "CANCELLED" },
  });
  revalidatePath("/advisor/reminders");
}
