"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendWhatsApp, appUrl } from "@/lib/whatsapp";
import { ensurePublicToken, resolveDocumentToken } from "@/lib/document-tokens";
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
  // Phase 2: fetch/generate the raw publicToken for the customer URL
  // instead of signing job.id with AUTH_SECRET. ensurePublicToken is a
  // no-op when the row was covered by the Phase-1 backfill; it
  // generates + persists only for rows created between backfill and
  // the create-site update landing in this same commit. Belt-and-
  // braces so no send ever ships a null-token link.
  const publicToken = await ensurePublicToken("delivery", job);
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
    body: `Your ${job.vehicle.make} ${job.vehicle.model} is ready for collection. Confirm here: ${appUrl()}/c/delivery/${publicToken}`,
  });

  revalidatePath(`/advisor/jobs/${jobId}`);
  revalidatePath("/advisor");
  revalidatePath("/advisor/eod");
  revalidatePath("/cashier");
}

// Customer-facing: the recipient of the WhatsApp confirm link stamps collection.
export async function confirmCollectionPublic(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const id = await resolveDocumentToken("delivery", token);
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
  // Revalidate the same URL the customer is on — pass the token they
  // received verbatim, regardless of shape.
  revalidatePath(`/c/delivery/${token}`);
}
