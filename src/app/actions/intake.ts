"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { runIntake } from "@/lib/intake";
import { saveUpload } from "@/lib/storage";

// PUBLIC — customer booking (no auth; this is the WhatsApp/web booking surface).
export async function createBookingPublic(formData: FormData) {
  const garageId = String(formData.get("garageId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const make = String(formData.get("make") ?? "").trim() || "Vehicle";
  const model = String(formData.get("model") ?? "").trim() || "";
  const plate = String(formData.get("plate") ?? "").trim() || "—";
  const text = String(formData.get("text") ?? "").trim();

  const garage = await prisma.garage.findUnique({ where: { id: garageId }, select: { id: true } });
  if (!garage || !phone || !text) throw new Error("Missing booking details");

  const customer = await prisma.customer.upsert({
    where: { garageId_phone: { garageId, phone } },
    update: { name: name || undefined },
    create: { garageId, phone, name: name || "Customer", lang: "ar", waId: phone },
  });

  let vehicle = await prisma.vehicle.findFirst({ where: { customerId: customer.id, plate } });
  if (!vehicle) {
    vehicle = await prisma.vehicle.create({ data: { customerId: customer.id, make, model, plate } });
  }

  const photoUrls: string[] = [];
  const photo = formData.get("photo");
  if (photo instanceof File && photo.size > 0) photoUrls.push(await saveUpload(photo, garageId));

  // AI proposes (metered to AiEvent); a human advisor confirms later.
  const proposal = await runIntake({ garageId, text });

  const booking = await prisma.booking.create({
    data: {
      garageId,
      customerId: customer.id,
      vehicleId: vehicle.id,
      channel: "WEB",
      rawText: text,
      photoUrls,
      aiProposalJson: proposal as object,
      status: "PROPOSED",
    },
    select: { id: true },
  });

  redirect(`/c/booking/${booking.id}`);
}

async function requireAdvisor() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADVISOR") throw new Error("Not authorized");
  return session.user;
}

export async function confirmBookingAction(formData: FormData) {
  const user = await requireAdvisor();
  const bookingId = String(formData.get("bookingId") ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, garageId: user.garageId },
    include: { jobCard: { select: { id: true } } },
  });
  if (!booking) throw new Error("Booking not found");
  if (booking.jobCard) redirect(`/advisor/jobs/${booking.jobCard.id}`);
  if (!booking.vehicleId) throw new Error("Booking has no vehicle");

  const job = await prisma.jobCard.create({
    data: {
      garageId: user.garageId,
      vehicleId: booking.vehicleId,
      advisorId: user.id,
      bookingId: booking.id,
      status: "ARRIVED",
    },
    select: { id: true },
  });
  await prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED" } });
  revalidatePath("/advisor/bookings");
  redirect(`/advisor/jobs/${job.id}`);
}

export async function rejectBookingAction(formData: FormData) {
  const user = await requireAdvisor();
  const bookingId = String(formData.get("bookingId") ?? "");
  await prisma.booking.updateMany({
    where: { id: bookingId, garageId: user.garageId, status: "PROPOSED" },
    data: { status: "REJECTED" },
  });
  revalidatePath("/advisor/bookings");
}
