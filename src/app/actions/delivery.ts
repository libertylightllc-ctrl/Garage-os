"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendWhatsApp, appUrl } from "@/lib/whatsapp";
import { signId, verifyToken } from "@/lib/tokens";
import { canRecordDelivery, validateDeliveryInput } from "@/lib/delivery";
import { dueDateFor } from "@/lib/reminders";
import { requireAnyRole } from "@/lib/action-guards";


// Advisor + Cashier (per Job-Card-Data-Model.md) record the vehicle delivery:
// mileage out + who delivered + when. Status advances INVOICED -> DELIVERED,
// and the customer gets a WhatsApp link to confirm collection.
//
// Gate (Workflow-Spec step 16): delivery is BLOCKED until the advisor has
// scheduled at least one maintenance reminder for this vehicle. The client
// disables the button; this action rejects the payload too — a manual
// curl / bypassed button cannot slip through.
export async function recordDeliveryAction(formData: FormData) {
  const user = await requireAnyRole(["ADVISOR", "CASHIER", "OWNER", "MASTER"]);
  const jobId = String(formData.get("jobId") ?? "");

  const parsed = validateDeliveryInput({
    types: formData.getAll("types"),
    serviceDate: String(formData.get("serviceDate") ?? ""),
    mileageOut: Number(formData.get("mileageOut") ?? NaN),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const { types, serviceDate, mileageOut } = parsed;

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    include: { vehicle: { include: { customer: true } } },
  });
  if (!job) throw new Error("Job not found in this garage");
  if (!canRecordDelivery(job.status)) {
    throw new Error("Delivery can only be recorded after the invoice is issued.");
  }

  const now = new Date();

  // Reminders + delivery flip must be atomic — either both land or the
  // advisor sees an error and retries. Prevents the "delivered but no
  // reminder" race that the whole gate exists to stop.
  await prisma.$transaction(async (tx) => {
    for (const type of types) {
      // Dedup on (vehicle, type) while a SCHEDULED reminder is still
      // active — same rule scheduleRemindersAction uses. Types the
      // advisor already scheduled earlier don't get duplicated.
      const existing = await tx.reminder.findFirst({
        where: { vehicleId: job.vehicleId, type, status: "SCHEDULED" },
        select: { id: true },
      });
      if (existing) continue;
      await tx.reminder.create({
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
    await tx.jobCard.update({
      where: { id: jobId },
      data: {
        mileageOut,
        deliveredById: user.id,
        deliveredAt: now,
        status: "DELIVERED",
        heldFrom: null,
        holdReason: null,
        holdNote: null,
      },
    });
  });

  // Send the customer a WhatsApp collection-confirm link (mock if no Meta token).
  const c = job.vehicle.customer;
  await sendWhatsApp({
    garageId: user.garageId,
    customerId: c.id,
    waId: c.waId ?? c.phone,
    template: "delivery_confirm",
    body: `Your ${job.vehicle.make} ${job.vehicle.model} is ready for collection. Confirm here: ${appUrl()}/c/delivery/${signId("delivery", job.id)}`,
  });

  revalidatePath(`/advisor/jobs/${jobId}`);
  revalidatePath("/advisor");
  revalidatePath("/advisor/eod");
  revalidatePath("/cashier");
  revalidatePath("/advisor/reminders");
  redirect("/advisor");
}

// Customer-facing: the recipient of the WhatsApp confirm link stamps collection.
export async function confirmCollectionPublic(formData: FormData) {
  const id = verifyToken("delivery", String(formData.get("token") ?? ""));
  if (!id) return;
  const job = await prisma.jobCard.findUnique({
    where: { id },
    select: { id: true, deliveryConfirmedAt: true },
  });
  if (!job || job.deliveryConfirmedAt) return; // idempotent
  await prisma.jobCard.update({
    where: { id },
    data: { deliveryConfirmedAt: new Date() },
  });
  revalidatePath(`/c/delivery/${signId("delivery", id)}`);
}
