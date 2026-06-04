"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { extractMoulkia, ocrCostUsd } from "@/lib/ocr";

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

  const start = Date.now();
  const r = await extractMoulkia(base64, mediaType);
  const latencyMs = Date.now() - start;

  // Meter every OCR call (kind = OCR) — protects margins.
  await prisma.aiEvent.create({
    data: {
      garageId: user.garageId,
      userId: user.id,
      kind: "OCR",
      model: r.model,
      sourceType: "MOULKIA",
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costEstimate: ocrCostUsd(r.model, r.tokensIn, r.tokensOut),
      latencyMs,
    },
  });

  redirect(
    confirmUrl({
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
    // Not on file → treat as a new customer, prefill just the plate.
    redirect(confirmUrl({ plate }));
  }
  const v = vehicle!;
  redirect(
    confirmUrl({
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

// Confirm step: create (or reuse) the customer + vehicle, then open the job card.
export async function createCustomerVehicleJobAction(formData: FormData) {
  const user = await requireAdvisor();
  const get = (k: string) => String(formData.get(k) ?? "").trim();

  const ownerName = get("ownerName");
  const phone = get("phone");
  const plate = get("plate");
  const make = get("make");
  const model = get("model");
  const vin = get("vin");
  const yearRaw = parseInt(get("year"), 10);
  const year = Number.isFinite(yearRaw) ? yearRaw : null;
  const assignedToRaw = get("assignedToId");
  let vehicleId = get("vehicleId");

  if (!ownerName || !phone || !plate || !make || !model) {
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

  if (vehicleId) {
    // Repeat / sold-vehicle path: confirm it's ours; allow owner name/phone edits.
    const existing = await prisma.vehicle.findFirst({
      where: { id: vehicleId, customer: { garageId: user.garageId } },
      include: { customer: true },
    });
    if (!existing) redirect("/advisor/jobs/new?error=fields");
    const ex = existing!;
    if (ex.customer.name !== ownerName || ex.customer.phone !== phone) {
      await prisma.customer.update({
        where: { id: ex.customerId },
        data: { name: ownerName, phone },
      });
    }
  } else {
    // New customer + vehicle (store only the extracted/confirmed fields). Upsert by
    // phone so a known customer (same number) gets the new vehicle attached, not an error.
    const customer = await prisma.customer.upsert({
      where: { garageId_phone: { garageId: user.garageId, phone } },
      update: { name: ownerName },
      create: { garageId: user.garageId, name: ownerName, phone },
      select: { id: true },
    });
    const vehicle = await prisma.vehicle.create({
      data: { customerId: customer.id, make, model, year, plate, vin: vin || null },
      select: { id: true },
    });
    vehicleId = vehicle.id;
  }

  const job = await prisma.jobCard.create({
    data: {
      garageId: user.garageId,
      vehicleId,
      advisorId: user.id,
      status: "ARRIVED",
      assignedToId,
    },
    select: { id: true },
  });

  revalidatePath("/advisor");
  redirect(`/advisor/jobs/${job.id}`);
}
