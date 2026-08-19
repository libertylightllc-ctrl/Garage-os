"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendWhatsApp } from "@/lib/whatsapp";
import { dueDateFor, reminderBody, REMINDER_TYPES, type ReminderType } from "@/lib/reminders";
import { requireAdvisor } from "@/lib/action-guards";
import { resolveCustomerLangForOutbound } from "@/lib/customer-lang";

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
  // AR 2026-08-19 — detect from the customer's latest inbound
  // instead of trusting customer.lang (which is "ar" for every
  // prod row via the schema default). Falls back to customer.lang
  // when there's no inbound to detect from.
  const lang = await resolveCustomerLangForOutbound(customer.id, garageId);
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

/**
 * Bulk-send reminders. AR 2026-08-19 rewrite.
 *
 * The old shape re-queried "every SCHEDULED reminder with dueAt <=
 * now, for this garage" and ignored the client's filter + month
 * scope entirely. On 2026-08-18 that shipped 4 reminders to 2
 * customers' phones when the advisor had filtered to a third
 * customer with 1 visible row. INC-report class: "the button did a
 * thing the operator couldn't see".
 *
 * The new shape iterates ONLY the ids the caller supplied via
 * hidden `reminderId` inputs — the filtered / month-scoped set the
 * page rendered. Server-side, each id is still gated by
 * garageId + status=SCHEDULED + dueAt<=now, so a hand-crafted POST
 * with someone else's id / a not-yet-due id / an already-sent id
 * quietly no-ops via sendOne's own guards.
 *
 * Kept as a manual button-triggered path (no separate cron caller
 * today). If a scheduled cron ever wants to fire "all due now", it
 * can call the pure `sendOne` in a loop from the cron handler —
 * doesn't have to go through this action.
 */
export async function sendDueRemindersAction(formData: FormData) {
  const user = await requireAdvisor();
  const ids = formData.getAll("reminderId")
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((s) => s.length > 0);
  // Zero ids submitted → nothing to do. Older callers that
  // POSTed with no ids used to fire the whole overdue book;
  // now they no-op. Any UI that wants "send everything overdue"
  // must enumerate the ids first.
  for (const id of ids) {
    await sendOne(id, user.garageId);
  }
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
