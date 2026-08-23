"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { runIntake } from "@/lib/intake";
import {
  saveUpload,
  validateImageUpload,
  PUBLIC_INTAKE_PHOTO_MAX_BYTES,
  LogoValidationError,
} from "@/lib/storage";
import { requireAdvisor } from "@/lib/action-guards";
import { newPublicToken } from "@/lib/document-tokens";
import { normalizeCustomerPhoneForWrite } from "@/lib/normalize";

// PUBLIC — customer booking (no auth; this is the WhatsApp/web booking surface).
export async function createBookingPublic(formData: FormData) {
  const garageId = String(formData.get("garageId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const make = String(formData.get("make") ?? "").trim() || "Vehicle";
  const model = String(formData.get("model") ?? "").trim() || "";
  const plate = String(formData.get("plate") ?? "").trim() || "—";
  const text = String(formData.get("text") ?? "").trim();

  const garage = await prisma.garage.findUnique({ where: { id: garageId }, select: { id: true } });
  if (!garage || !phoneRaw || !text) throw new Error("Missing booking details");

  // AR 2026-08-23 — route through the shared write-time contract.
  // Resolvable input → E.164 stored + needsReview=false. Unresolvable
  // input (a real string that isn't a dialable number) → raw stored
  // + needsReview=true so the customer detail page can highlight it
  // for an advisor to fix. Refuse only when the input is blank —
  // "we lost the number entirely" is genuinely missing data. See
  // `normalizeCustomerPhoneForWrite` for the contract; before AR
  // 2026-08-23 this path used `normalizeUaePhone` which stored a
  // 9-digit shape the send path (`normalizeToE164`) then rejected,
  // leaving the cashier with a picker-fallback wa.me and no
  // explanation.
  const resolved = normalizeCustomerPhoneForWrite(phoneRaw);
  if (!resolved) throw new Error("Missing booking details");
  const { phone, needsReview: phoneNeedsReview } = resolved;

  const customer = await prisma.customer.upsert({
    where: { garageId_phone: { garageId, phone } },
    update: { name: name || undefined, phoneNeedsReview },
    create: { garageId, phone, phoneNeedsReview, name: name || "Customer", waId: phone },
  });

  let vehicle = await prisma.vehicle.findFirst({ where: { customerId: customer.id, plate } });
  if (!vehicle) {
    vehicle = await prisma.vehicle.create({ data: { customerId: customer.id, make, model, plate } });
  }

  const photoUrls: string[] = [];
  const photo = formData.get("photo");
  if (photo instanceof File && photo.size > 0) {
    // Public unauthenticated surface — magic-byte + MIME allowlist
    // BEFORE storage, tighter size cap than the authenticated flows.
    // On rejection, redirect BACK to the booking form with an enum
    // code in the query string (never provider text, never the raw
    // exception message — see the render-side whitelist on the
    // booking page for the same discipline as ?emailError= in the
    // purchasing flow). Throwing an Error here hits Next's generic
    // error boundary — "Something went wrong / ref: 1900925717" — and
    // the customer has no idea their photo was the problem. That
    // regression breaks bookings for anyone uploading a HEIC iPhone
    // photo or an oversize image, so the code round-trips through the
    // URL and renders as a proper banner.
    try {
      await validateImageUpload(photo, { maxBytes: PUBLIC_INTAKE_PHOTO_MAX_BYTES });
    } catch (e) {
      if (e instanceof LogoValidationError) {
        redirect(`/c/book/${garageId}?photoError=${e.code}`);
      }
      throw e;
    }
    photoUrls.push(await saveUpload(photo, garageId));
  }

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

  // AR 2026-08-18 — revalidate the two staff surfaces that read
  // Booking.status='PROPOSED': the advisor bookings inbox and the
  // dashboard badge counter (see src/app/advisor/page.tsx:93).
  // Without these the new booking is invisible to staff until Next's
  // route cache times out — customer submits and the shop doesn't
  // know about it. Same class as approve/reject on the estimate.
  revalidatePath("/advisor/bookings");
  revalidatePath("/advisor");

  redirect(`/c/booking/${booking.id}`);
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

  // Carry-over from Booking → JobCard (AR 2026-08-21 — was silently
  // dropping the customer's own complaint text and any photos they
  // uploaded on the public booking page):
  //   - rawText → JobCard.complaint (the "customer said..." field
  //     the tech reads first). Whitespace-trimmed; empty stays null
  //     so the "no complaint" branch on the tech page renders
  //     unchanged.
  //   - photoUrls → one JobStep(type=PHOTO) per URL. Reuses the same
  //     display path as the advisor's later check-in photos (see
  //     checkInPhotoAction in jobs.ts:604) — no new column needed.
  //     Transcript names them explicitly so the timeline reads
  //     "Booking photo" not just an unlabelled thumbnail.
  //
  // Booking has no check-in condition field (schema:520 — Booking
  // carries rawText / voiceNoteUrl / photoUrls / aiProposalJson;
  // exterior/interior condition are captured at the JobCard reception
  // stage). Nothing to lose there. voiceNoteUrl carry-over deferred —
  // no JobStep type for audio today.
  const complaint = booking.rawText?.trim() || null;
  const photoUrls = booking.photoUrls ?? [];

  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.jobCard.create({
      data: {
        garageId: user.garageId,
        vehicleId: booking.vehicleId!,
        advisorId: user.id,
        bookingId: booking.id,
        status: "ARRIVED",
        publicToken: newPublicToken(),
        complaint,
      },
      select: { id: true },
    });
    if (photoUrls.length > 0) {
      await tx.jobStep.createMany({
        data: photoUrls.map((url) => ({
          jobCardId: created.id,
          type: "PHOTO" as const,
          transcript: "Booking photo",
          photoUrl: url,
        })),
      });
    }
    await tx.booking.update({
      where: { id: booking.id },
      data: { status: "CONFIRMED" },
    });
    return created;
  });

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
