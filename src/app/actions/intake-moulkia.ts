"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { extractMoulkia, ocrCostUsd } from "@/lib/ocr";
import {
  sanitizeChoices,
  toOilType,
  toFuelLevel,
  EXTERIOR_OPTIONS,
  INTERIOR_OPTIONS,
  VALUABLES_OPTIONS,
} from "@/lib/jobcard-fields";

async function requireAdvisor() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADVISOR") throw new Error("Not authorized");
  return session.user;
}

function confirmUrl(params: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `/advisor/jobs/new/confirm?${q.toString()}`;
}

// Upload a Moulkia photo → OCR (in-memory, image not persisted) → prefilled confirm page.
export async function moulkiaExtractAction(formData: FormData) {
  const user = await requireAdvisor();

  // Consent is required before we extract personal data from the Moulkia.
  if (String(formData.get("consent") ?? "") !== "on") {
    redirect("/advisor/jobs/new?error=consent");
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/advisor/jobs/new?error=nofile");
  }
  const f = file as File;
  const assignedToId = String(formData.get("assignedToId") ?? "");

  const base64 = Buffer.from(await f.arrayBuffer()).toString("base64");
  const mediaType = f.type || "image/jpeg";

  const r = await extractMoulkia(base64, mediaType);

  // Meter EVERY attempt as its own AiEvent (kind = OCR). If the primary model
  // fails and the fallback succeeds, that's two rows — both visible in metering
  // so cost + reliability per model can be inspected later.
  for (const a of r.attempts) {
    await prisma.aiEvent.create({
      data: {
        garageId: user.garageId,
        userId: user.id,
        kind: "OCR",
        model: a.model,
        sourceType: a.error ? `MOULKIA:${a.error}` : "MOULKIA",
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        costEstimate: ocrCostUsd(a.model, a.tokensIn, a.tokensOut),
        latencyMs: a.latencyMs,
      },
    });
  }

  // Every real attempt failed → route to manual entry with a clear banner.
  if (r.failed) {
    redirect(confirmUrl({ via: "manual", error: "ocr", assignedToId }));
  }

  redirect(
    confirmUrl({
      via: "moulkia",
      ownerName: r.fields.ownerName,
      plate: r.fields.plate,
      make: r.fields.make,
      model: r.fields.model,
      year: r.fields.year ? String(r.fields.year) : "",
      vin: r.fields.vin,
      assignedToId,
    }),
  );
}

// Repeat customer: look up an existing vehicle by plate and prefill from the record.
export async function plateLookupAction(formData: FormData) {
  const user = await requireAdvisor();
  const plate = String(formData.get("plate") ?? "").trim();
  if (!plate) redirect("/advisor/jobs/new?error=noplate");

  const vehicle = await prisma.vehicle.findFirst({
    where: { plate: { equals: plate, mode: "insensitive" }, customer: { garageId: user.garageId } },
    include: { customer: true },
  });

  if (!vehicle) {
    // Not on file → treat as a new customer (no Moulkia photo), prefill just the plate.
    redirect(confirmUrl({ via: "manual", plate }));
  }
  const v = vehicle!;
  redirect(
    confirmUrl({
      via: "repeat",
      vehicleId: v.id,
      ownerName: v.customer.name,
      phone: v.customer.phone,
      plate: v.plate,
      make: v.make,
      model: v.model,
      year: v.year ? String(v.year) : "",
      vin: v.vin ?? "",
    }),
  );
}

// Confirm step (the Reception form): create/reuse customer + vehicle, then open the
// job card with EVERY reception field — make/model/year always written (no blank Vehicle).
export async function createCustomerVehicleJobAction(formData: FormData) {
  const user = await requireAdvisor();
  const get = (k: string) => String(formData.get(k) ?? "").trim();
  const getAll = (k: string) => formData.getAll(k).map(String);

  // Customer + vehicle identity
  const ownerName = get("ownerName");
  const phone = get("phone");
  const email = get("email") || null;
  const plate = get("plate");
  const make = get("make");
  const model = get("model");
  const vin = get("vin") || null;
  const yearRaw = parseInt(get("year"), 10);
  const year = Number.isFinite(yearRaw) ? yearRaw : null;
  const assignedToRaw = get("assignedToId");
  let vehicleId = get("vehicleId");

  // Reception detail
  const mileageRaw = parseInt(get("mileageIn"), 10);
  const mileageIn = Number.isFinite(mileageRaw) ? mileageRaw : null;
  const oilType = toOilType(get("oilType"));
  const fuelLevel = toFuelLevel(get("fuelLevel"));
  const complaint = get("complaint");
  const exteriorCondition = sanitizeChoices(getAll("exterior"), EXTERIOR_OPTIONS);
  const exteriorRemarks = get("exteriorRemarks") || null;
  const interiorCondition = sanitizeChoices(getAll("interior"), INTERIOR_OPTIONS);
  const interiorRemarks = get("interiorRemarks") || null;
  const valuables = sanitizeChoices(getAll("valuables"), VALUABLES_OPTIONS);
  const valuablesNote = get("valuablesNote") || null;
  // Consent is about extracting from a Moulkia photo — only required on the OCR path.
  const via = get("via") || "moulkia";
  const consent = get("consent") === "on";
  const consentOk = via !== "moulkia" || consent;

  // Required: identity + complaint (+ consent on the OCR path).
  if (!ownerName || !phone || !plate || !make || !model || !complaint || !consentOk) {
    redirect("/advisor/jobs/new?error=fields");
  }

  // Resolve assigned tech (optional, must be in this garage).
  let assignedToId: string | null = null;
  if (assignedToRaw) {
    const tech = await prisma.user.findFirst({
      where: { id: assignedToRaw, garageId: user.garageId, role: "TECH" },
      select: { id: true },
    });
    assignedToId = tech?.id ?? null;
  }

  const jobId = await prisma.$transaction(async (tx) => {
    if (vehicleId) {
      // Repeat / sold-vehicle path: confirm it's ours; keep details fresh.
      const existing = await tx.vehicle.findFirst({
        where: { id: vehicleId, customer: { garageId: user.garageId } },
        select: { id: true, customerId: true },
      });
      if (!existing) throw new Error("Vehicle not found in this garage");
      await tx.customer.update({
        where: { id: existing.customerId },
        data: { name: ownerName, phone, email },
      });
      await tx.vehicle.update({
        where: { id: existing.id },
        data: { make, model, year, plate, vin },
      });
    } else {
      // New customer + vehicle. Upsert customer by phone so a known number attaches.
      const customer = await tx.customer.upsert({
        where: { garageId_phone: { garageId: user.garageId, phone } },
        update: { name: ownerName, email },
        create: { garageId: user.garageId, name: ownerName, phone, email },
        select: { id: true },
      });
      const vehicle = await tx.vehicle.create({
        data: { customerId: customer.id, make, model, year, plate, vin },
        select: { id: true },
      });
      vehicleId = vehicle.id;
    }

    // Gapless per-garage Job Card No.
    const g = await tx.garage.update({
      where: { id: user.garageId },
      data: { jobSeq: { increment: 1 } },
      select: { jobSeq: true },
    });

    const job = await tx.jobCard.create({
      data: {
        garageId: user.garageId,
        vehicleId,
        advisorId: user.id,
        status: "ARRIVED",
        assignedToId,
        number: g.jobSeq,
        mileageIn,
        oilType,
        fuelLevel,
        complaint,
        exteriorCondition,
        exteriorRemarks,
        interiorCondition,
        interiorRemarks,
        valuables,
        valuablesNote,
        moulkiaConsentAt: consent ? new Date() : null,
      },
      select: { id: true },
    });
    return job.id;
  });

  revalidatePath("/advisor");
  redirect(`/advisor/jobs/${jobId}`);
}
