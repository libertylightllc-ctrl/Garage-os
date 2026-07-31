"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { safeLogAiEvent } from "@/lib/ai-event-log";
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
  toFuelType,
  EXTERIOR_OPTIONS,
  INTERIOR_OPTIONS,
  VALUABLES_OPTIONS,
} from "@/lib/jobcard-fields";
import { requireAdvisor } from "@/lib/action-guards";
import { clampPriority } from "@/lib/priority";
import { normalizeVin, normalizeUaePhone, normalizePlate } from "@/lib/normalize";


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
    // safeLogAiEvent — never throws. A stale JWT / rotated user id used
    // to FK-violate here and take down the whole intake POST; see
    // docs/telemetry-must-not-crash-operation-spec.md.
    await safeLogAiEvent({
      garageId,
      userId,
      kind: "OCR",
      model: a.model,
      sourceType: a.error ? `MOULKIA_${sourceSide}:${a.error}` : `MOULKIA_${sourceSide}`,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      costEstimate: ocrCostUsd(a.model, a.tokensIn, a.tokensOut),
      latencyMs: a.latencyMs,
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

// Plate search on the intake landing page. Slice 3 (2026-07-30):
// hits the disambiguation panel when the plate is on record, so the
// advisor consciously picks "same car / same owner", "same car / new
// owner", "different car — same plate", or "wrong plate". The prior
// behaviour prefilled the confirm form directly, which silently
// assumed same-car-same-owner and made the "sold" case impossible
// to signal without hand-editing the confirm fields (and, under
// slice 5, ended in a duplicate write).
export async function plateLookupAction(formData: FormData) {
  const user = await requireAdvisor();
  const plateRaw = String(formData.get("plate") ?? "").trim();
  if (!plateRaw) redirect("/advisor/jobs/new?error=noplate");

  // Normalise the search key to match the storage rule in
  // createCustomerVehicleJobAction — new writes go in as
  // normalizePlate(x), so an advisor typing "A 12345" must match a
  // stored "A12345". Legacy rows written before slice 5 kept whatever
  // formatting the advisor typed and may not match; slice 1a's
  // backfill closes that gap.
  const plate = normalizePlate(plateRaw);

  const vehicle = await prisma.vehicle.findFirst({
    where: { plate, customer: { garageId: user.garageId } },
    select: { id: true },
  });

  if (!vehicle) {
    // Not on file → treat as a new customer (no Moulkia photo), prefill just the plate.
    redirect(confirmUrl({ via: "manual", plate }));
  }
  // On file → panel decides what happens next.
  redirect(
    `/advisor/jobs/new/existing-vehicle/${vehicle!.id}?via=repeat&plate=${encodeURIComponent(plate)}`,
  );
}

// Confirm step (the Reception form): create/reuse customer + vehicle, then open the
// job card with EVERY reception field — make/model/year always written.
export async function createCustomerVehicleJobAction(formData: FormData) {
  const user = await requireAdvisor();
  const get = (k: string) => String(formData.get(k) ?? "").trim();
  const getAll = (k: string) => formData.getAll(k).map(String);

  // Customer + vehicle identity. VIN, phone, AND plate are normalised
  // at write time (and at compare time in the pre-flight below) so
  // different formats of the same value stop creating parallel records:
  //   VIN:    "5n1ar2 mm7dc-605739" → "5N1AR2MM7DC605739"
  //   Phone:  "+971 50 123 4567" / "0501234567" / "971501234567" →
  //           "501234567"
  //   Plate:  "A 12345" / "a-12345" → "A12345"
  // Legacy rows in prod may not be normalised; slice 1a audits + backfills
  // before slice 1 adds the normalized columns and indexes.
  //
  // Cost of slice 5 normalising storage: if a legacy Customer row exists
  // with an un-normalised phone (e.g. "0501234567"), the upsert below
  // will look up by the normalised "501234567", miss the legacy row, and
  // create a duplicate Customer. Same class of gap for legacy Vehicle
  // rows with un-normalised plate/vin. Slice 1a's backfill collapses
  // these once run.
  const ownerName = get("ownerName");
  const phone = normalizeUaePhone(get("phone"));
  const email = get("email") || null;
  const plateRaw = get("plate");
  const plate = plateRaw ? normalizePlate(plateRaw) : "";
  const make = get("make");
  const model = get("model");
  const vinRaw = get("vin");
  const vin = vinRaw ? normalizeVin(vinRaw) : null;
  const yearRaw = parseInt(get("year"), 10);
  const year = Number.isFinite(yearRaw) ? yearRaw : null;
  // Intrinsic vehicle spec — these live on Vehicle so they survive
  // across job cards. engineSize is free text; fuelType is validated
  // against FUEL_TYPES below (matches the JobCard.fuelType slot).
  const engineSize = get("engineSize") || null;
  const assignedToRaw = get("assignedToId");
  let vehicleId = get("vehicleId");
  // Slice 3 disambiguation flags — set by the intake collision panel.
  // See src/app/advisor/jobs/new/existing-vehicle/[vehicleId]/page.tsx.
  //
  //   editOwner=1        → Choice 2 (same car, owner has changed).
  //                        Do a real FK move on Vehicle.customerId,
  //                        NEVER mutate the previous Customer row in
  //                        place (would corrupt every other Vehicle /
  //                        Booking / Reminder still attached to them).
  //                        Write a VehicleOwnershipTransfer audit row.
  //   releasePlateFrom=X → Choice 3 (different car, same plate). The
  //                        old Vehicle X keeps its VIN + service
  //                        history but loses this plate; the new
  //                        Vehicle we're about to create takes it.
  //                        Both writes happen in ONE transaction so
  //                        the plate can never briefly belong to
  //                        neither vehicle.
  const editOwner = get("editOwner") === "1";
  const releasePlateFrom = get("releasePlateFrom") || null;

  // Reception detail
  const mileageRaw = parseInt(get("mileageIn"), 10);
  const mileageIn = Number.isFinite(mileageRaw) ? mileageRaw : null;
  // oilType field has been hidden from the intake UI for now (the
  // schema column stays per the 'we may revisit oil spec later' note
  // in CLAUDE.md). Empty form value coerces to NONE, which matches
  // the column default — safe transition.
  const oilType = toOilType(get("oilType"));
  const fuelType = toFuelType(get("fuelType")); // null if unset
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

  // ── Pre-flight: identify Cases A, B, C before writing anything ────────
  // Vehicle has NO unique on (garageId, plate) at the schema level, so a
  // naive `vehicle.create` under a different customer would silently
  // corrupt the plate namespace. Schema won't catch it; the action has
  // to. Every lookup below is garage-scoped via
  // `customer: { garageId: user.garageId }`.
  //
  //   Case A (implicit): plate + phone match the same customer → route
  //     through the existing `vehicleId` branch (refresh customer /
  //     vehicle metadata, reuse the row).
  //   Case B: plate matches a different customer's Vehicle → redirect
  //     to the disambiguation panel unless the advisor already picked
  //     a choice (editOwner=1 or releasePlateFrom=…). No write happens
  //     on the panel-redirect path.
  //   Case C: plate is new; customer's phone exists → fallthrough
  //     (upsert customer, create vehicle).
  //   Default: everything is new → fallthrough.
  //
  // Skip pre-flight when `vehicleId` is set OR the disambiguation
  // panel has already routed a specific choice here (editOwner /
  // releasePlateFrom). Panel-set flags are the advisor's explicit
  // decision; we honour them without re-detecting.
  if (!vehicleId && !releasePlateFrom) {
    const [existingVehicleByPlate, existingCustomer] = await Promise.all([
      prisma.vehicle.findFirst({
        where: { plate, customer: { garageId: user.garageId } },
        select: { id: true, customerId: true },
      }),
      prisma.customer.findFirst({
        where: { garageId: user.garageId, phone },
        select: { id: true },
      }),
    ]);
    // Case A (by plate): plate + phone both match the same customer.
    if (
      existingVehicleByPlate &&
      existingCustomer &&
      existingVehicleByPlate.customerId === existingCustomer.id
    ) {
      vehicleId = existingVehicleByPlate.id;
    } else if (vin) {
      // Case A (by VIN) — the OCR-came-back-with-a-known-chassis shortcut.
      // Only take this path when BOTH the VIN matches AND the incoming
      // phone matches that VIN's current owner.
      //
      // Phone equality is deliberately weak evidence on its own — fleet
      // vehicles (delivery, taxi, corporate) commonly share one contact
      // number across many cars, so a phone match without a VIN match
      // proves nothing. It's acceptable HERE because VIN is the primary
      // signal; the phone check is defence-in-depth against reassigning
      // a VIN-matched Vehicle to the wrong customer without going
      // through the ownership-change flow (slice 3).
      //
      //   - VIN matches but phone doesn't → could be plate transfer OR
      //     ownership change; NOT safe to shortcut, needs the
      //     disambiguation panel (slice 3). Fall through to today's
      //     default create path so the advisor is unblocked, with the
      //     plate-collision warning if applicable.
      //   - No VIN provided → legacy / skipped-OCR path; can't shortcut.
      //   - Plate on the reused Vehicle may differ from the incoming
      //     plate (customer brought the same car back with a new plate).
      //     Slice 4 owns the auto-plate-update + history bookkeeping;
      //     slice 5 leaves the existing plate alone.
      //
      // `vin` is already normalised (see above) so `equals` is a
      // canonicalised compare against normalised writes. Legacy rows
      // that pre-date normalisation may still hold raw formats and
      // won't match; the shortcut is best-effort until slice 1a
      // backfills.
      const byVin = await prisma.vehicle.findFirst({
        where: {
          vin,
          customer: { garageId: user.garageId },
        },
        select: { id: true, customerId: true },
      });
      if (byVin && existingCustomer && byVin.customerId === existingCustomer.id) {
        vehicleId = byVin.id;
      }
    }
    if (!vehicleId && existingVehicleByPlate) {
      // Case B — plate currently on a different customer's Vehicle and
      // no shortcut applied. Redirect to the disambiguation panel; no
      // writes happen here. The advisor picks a choice, and comes
      // back through this action with editOwner=1 (Choice 2) or
      // releasePlateFrom=<id> (Choice 3), or under a fresh vehicleId
      // (Choice 1), which shortcut this pre-flight.
      //
      // Carry forward every form field the advisor already typed so
      // the panel's redirects can prefill downstream forms. This
      // includes ownerName / phone (potentially the new owner) so
      // Choice 3's manual path doesn't blank them.
      const forward = new URLSearchParams({
        via,
        plate,
        ownerName,
        phone,
        make,
        model,
        year: year != null ? String(year) : "",
        vin: vin ?? "",
        engineSize: engineSize ?? "",
        fuelType: fuelType ?? "",
        assignedToId: assignedToRaw,
      });
      redirect(
        `/advisor/jobs/new/existing-vehicle/${existingVehicleByPlate.id}?${forward.toString()}`,
      );
    }
    // Case C and default fall through to the transaction below untouched.
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

  // Queue priority — clamped to 0/1/2 via the same helper the setPriorityAction
  // uses on /advisor/jobs/[id]. Blank input coerces to 0 (normal), which also
  // matches JobCard.priority @default(0) — leaving the picker untouched is a
  // no-op.
  const priority = clampPriority(Number(get("priority") || 0));

  // Bay — must be in this garage. Unknown/blank → null (no bay), matching
  // today's default. No occupancy check at intake by design: setBayAction on
  // /advisor/jobs/[id] is also loose, and enforcing it in only one place
  // would leak the invariant.
  const bayRaw = get("bayId");
  let bayId: string | null = null;
  if (bayRaw) {
    const bay = await prisma.bay.findFirst({
      where: { id: bayRaw, garageId: user.garageId },
      select: { id: true },
    });
    bayId = bay?.id ?? null;
  }

  const jobId = await prisma.$transaction(async (tx) => {
    if (vehicleId && editOwner) {
      // Slice 3 Choice 2 — same car, owner has changed. FK move on
      // Vehicle.customerId to a Customer keyed by the NEW phone;
      // NEVER mutate the previous Customer's row (would corrupt every
      // other Vehicle / Booking / Reminder still attached to them).
      // Snapshot the previous owner in the audit before the FK moves.
      const existing = await tx.vehicle.findFirst({
        where: { id: vehicleId, customer: { garageId: user.garageId } },
        include: { customer: { select: { id: true, name: true, phone: true } } },
      });
      if (!existing) throw new Error("Vehicle not found in this garage");
      const previousOwner = existing.customer;
      const newCustomer = await tx.customer.upsert({
        where: { garageId_phone: { garageId: user.garageId, phone } },
        update: { name: ownerName, email },
        create: { garageId: user.garageId, name: ownerName, phone, email },
        select: { id: true },
      });
      if (newCustomer.id !== previousOwner.id) {
        await tx.vehicleOwnershipTransfer.create({
          data: {
            vehicleId: existing.id,
            fromCustomerId: previousOwner.id,
            toCustomerId: newCustomer.id,
            transferredByUserId: user.id,
            previousOwnerName: previousOwner.name,
            previousOwnerPhone: previousOwner.phone,
          },
        });
        await tx.vehicle.update({
          where: { id: existing.id },
          data: {
            customerId: newCustomer.id,
            make, model, year, plate, vin, engineSize, fuelType,
          },
        });
      } else {
        // Same-phone edge: the "new" owner is really the same
        // Customer row. Fall back to Choice 1 semantics for the
        // vehicle-metadata refresh only. No transfer row written.
        await tx.customer.update({
          where: { id: previousOwner.id },
          data: { name: ownerName, email },
        });
        await tx.vehicle.update({
          where: { id: existing.id },
          data: { make, model, year, plate, vin, engineSize, fuelType },
        });
      }
    } else if (vehicleId) {
      // Choice 1 / plate-lookup Case A — same car, same owner. Refresh
      // customer contact info and vehicle metadata on the existing
      // row; no FK move, no audit row.
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
        data: { make, model, year, plate, vin, engineSize, fuelType },
      });
    } else {
      // New Vehicle path — Choice 3 (releasePlateFrom set) OR plate-is-new
      // default. Either way we upsert the Customer by phone and create a
      // fresh Vehicle row + open a VehiclePlateHistory row for the plate.
      //
      // Choice 3 also closes the old Vehicle's plate history + blanks its
      // plate cache. Both happen in this transaction so the plate is
      // never "attached to nothing" between the two writes.
      if (releasePlateFrom) {
        const oldVehicle = await tx.vehicle.findFirst({
          where: { id: releasePlateFrom, customer: { garageId: user.garageId } },
          select: { id: true, plate: true },
        });
        if (!oldVehicle) throw new Error("Old vehicle not found in this garage");
        // Close every currently-open plate history row for this Vehicle
        // (should be exactly one, but updateMany is safe if the backfill
        // left a stray).
        await tx.vehiclePlateHistory.updateMany({
          where: { vehicleId: oldVehicle.id, releasedAt: null },
          data: { releasedAt: new Date(), releasedByUserId: user.id },
        });
        await tx.vehicle.update({
          where: { id: oldVehicle.id },
          data: { plate: "" },
        });
      }
      const customer = await tx.customer.upsert({
        where: { garageId_phone: { garageId: user.garageId, phone } },
        update: { name: ownerName, email },
        create: { garageId: user.garageId, name: ownerName, phone, email },
        select: { id: true },
      });
      const vehicle = await tx.vehicle.create({
        data: { customerId: customer.id, make, model, year, plate, vin, engineSize, fuelType },
        select: { id: true },
      });
      if (plate) {
        await tx.vehiclePlateHistory.create({
          data: {
            vehicleId: vehicle.id,
            plate,
            normalizedPlate: plate, // already normalised at the top
            attachedByUserId: user.id,
          },
        });
      }
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
        priority,
        bayId,
        number: g.jobSeq,
        mileageIn,
        oilType,
        fuelType,
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
  // Hand-off confirmation screen — explicit "you sent this to a tech" page
  // before dropping the advisor onto the job timeline. Slice 3 removed
  // the plateWarning URL param the slice-5 done page was reading; the
  // disambiguation panel intercepts BEFORE the write, so there's no
  // ambiguous state to warn about post-create.
  redirect(`/advisor/jobs/new/done?jobId=${jobId}`);
}
