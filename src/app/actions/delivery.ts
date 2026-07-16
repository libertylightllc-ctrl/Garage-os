"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendWhatsApp, appUrl } from "@/lib/whatsapp";
import { signId, verifyToken } from "@/lib/tokens";
import { canRecordDelivery, cleanMileage } from "@/lib/delivery";
import { requireAnyRole } from "@/lib/action-guards";


// Advisor + Cashier (per Job-Card-Data-Model.md) record the vehicle delivery:
// mileage out + who delivered + when. Status advances INVOICED -> DELIVERED, and the
// customer gets a WhatsApp link to confirm collection (signature equivalent).
export async function recordDeliveryAction(formData: FormData) {
  const user = await requireAnyRole(["ADVISOR", "CASHIER", "OWNER", "MASTER"]);
  const jobId = String(formData.get("jobId") ?? "");
  const mileageOut = cleanMileage(Number(formData.get("mileageOut") ?? NaN));
  if (mileageOut === null) throw new Error("Enter a valid mileage out.");

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    include: { vehicle: { include: { customer: true } } },
  });
  if (!job) throw new Error("Job not found in this garage");
  if (!canRecordDelivery(job.status)) {
    throw new Error("Delivery can only be recorded after the invoice is issued.");
  }

  const now = new Date();
  await prisma.jobCard.update({
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
