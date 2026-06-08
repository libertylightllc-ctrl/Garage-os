"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  extractMoulkiaFront,
  extractMoulkiaBack,
  mergeMoulkiaFields,
  ocrCostUsd,
  type OcrAttempt,
  type MoulkiaFront,
} from "@/lib/ocr";
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

function buildQuery(params: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return q.toString();
}

function confirmUrl(params: Record<string, string>): string {
  return `/advisor/jobs/new/confirm?${buildQuery(params)}`;
}

function backUrl(params: Record<string, string>): string {
  return `/advisor/jobs/new/back?${buildQuery(params)}`;
}

async function logAttempts(
  attempts: OcrAttempt[],
  garageId: string,
  userId: string,
  sourceSide: "FRONT" | "BACK",
) {
  for (const a of attempts) {
    await prisma.aiEvent.create({
      data: {
        garageId,
        userId,
        kind: "OCR",
        model: a.model,
        sourceType: a.error ? `MOULKIA_${sourceSide}:${a.error}` : `MOULKIA_${sourceSide}`,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        costEstimate: ocrCostUsd(a.model, a.tokensIn, a.tokensOut),
        latencyMs: a.latencyMs,
      },
    });
  }
}

// ----------------------------------------------------------------------------
// Step 1 — Photograph the FRONT of the Moulkia (owner + plate)
// ----------------------------------------------------------------------------
export async function moulkiaFrontAction(formData: FormData) {
  const user = await requireAdvisor();

  // Consent gate (kept; covered by hidden consent=on input from the by-action UX).
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

  const r = await extractMoulkiaFront(base64, mediaType);
  await logAttempts(r.attempts, user.garageId, user.id, "FRONT");

  if (r.failed) {
    // Can't read the front — no point asking for the back. Go straight to manual entry.
    redirect(confirmUrl({ via: "manual", error: "ocr", assignedToId }));
  }

  // Front succeeded → go to step 2 (back), carrying every field the front
  // captured (owner + plate + make + model + year + VIN). The back step
  // can still override on overlap; if the advisor skips it, these values
  // become the final answer.
  redirect(
    backUrl({
      ownerName: r.fields.ownerName,
      plate: r.fields.plate,
      vin: r.fields.vin,
      make: r.fields.make,
      model: r.fields.model,
      year: r.fields.year ? String(r.fields.year) : "",
      assignedToId,
    }),
  );
}

// ----------------------------------------------------------------------------
// Step 2 — Photograph the BACK of the Moulkia (VIN + make + model + year)
// ----------------------------------------------------------------------------
export async function moulkiaBackAction(formData: FormData) {
  const user = await requireAdvisor();

  // Read the front fields that rode in via hidden inputs. The FRONT prompt
  // now captures vehicle specs too, so we carry them through and let merge
  // decide which wins. Back overrides on overlap; front fills the gaps.
  function readFrontFromForm(): MoulkiaFront {
    const yearRaw = String(formData.get("frontYear") ?? "").trim();
    const yearN = parseInt(yearRaw, 10);
    return {
      ownerName: String(formData.get("frontOwnerName") ?? "").trim(),
      plate: String(formData.get("frontPlate") ?? "").trim(),
      vin: String(formData.get("frontVin") ?? "").trim(),
      make: String(formData.get("frontMake") ?? "").trim(),
      model: String(formData.get("frontModel") ?? "").trim(),
      year: Number.isFinite(yearN) && yearN >= 1950 && yearN <= 2100 ? yearN : null,
    };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    // Treat as a skip back — let the advisor fill the back fields manually,
    // but keep everything the FRONT scan already gave us.
    const front = readFrontFromForm();
    redirect(
      confirmUrl({
        via: "moulkia",
        skippedBack: "1",
        assignedToId: String(formData.get("assignedToId") ?? ""),
        ownerName: front.ownerName,
        plate: front.plate,
        vin: front.vin,
        make: front.make,
        model: front.model,
        year: front.year ? String(front.year) : "",
      }),
    );
  }
  const f = file as File;
  const assignedToId = String(formData.get("assignedToId") ?? "");
  const front = readFrontFromForm();

  const base64 = Buffer.from(await f.arrayBuffer()).toString("base64");
  const mediaType = f.type || "image/jpeg";

  const r = await extractMoulkiaBack(base64, mediaType);
  await logAttempts(r.attempts, user.garageId, user.id, "BACK");

  if (r.failed) {
    // Back unreadable — still proceed with the front fields and flag the gap.
    redirect(
      confirmUrl({
        via: "moulkia",
        error: "ocrBack",
        assignedToId,
        ownerName: front.ownerName,
        plate: front.plate,
        vin: front.vin,
        make: front.make,
        model: front.model,
        year: front.year ? String(front.year) : "",
      }),
    );
  }

  const merged = mergeMoulkiaFields(front, r.fields);
  redirect(
    confirmUrl({
      via: "moulkia",
      assignedToId,
      ownerName: merged.ownerName,
      plate: merged.plate,
      vin: merged.vin,
      make: merged.make,
      model: merged.model,
      year: merged.year ? String(merged.year) : "",
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
// job card with EVERY reception field — make/model/year always written.
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
