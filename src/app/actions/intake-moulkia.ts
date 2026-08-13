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
import { newPublicToken } from "@/lib/document-tokens";
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
    //
    // Tier 1 taxonomy (AR 2026-08-14): failing attempts land as
    // `MOULKIA_<side>:<category>:<message>` where <category> is one of
    // billing|temporary|generic. Ops can grep the sourceType directly:
    //   SELECT ... WHERE "sourceType" LIKE 'MOULKIA_%:billing:%'
    // Successful attempts stay bare `MOULKIA_<side>` — no colon suffix,
    // grep is unambiguous.
    const category = a.errorCategory ?? "generic";
    await safeLogAiEvent({
      garageId,
      userId,
      kind: "OCR",
      model: a.model,
      sourceType: a.error
        ? `MOULKIA_${sourceSide}:${category}:${a.error}`
        : `MOULKIA_${sourceSide}`,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      costEstimate: ocrCostUsd(a.model, a.tokensIn, a.tokensOut),
      latencyMs: a.latencyMs,
    });
  }
}

// TTL for an IntakeDraft. Two hours matches a real intake window
// (advisor might take a phone call between the two photos or step
// away). Long enough to survive that, short enough that abandoned
// drafts don't accumulate in the DB — each fresh scan sweeps
// expired rows in the same garage before creating a new one.
const INTAKE_DRAFT_TTL_MS = 2 * 60 * 60 * 1000;

// ----------------------------------------------------------------------------
// Step 1 — Photograph the FRONT of the Moulkia (owner + plate)
// ----------------------------------------------------------------------------
// Persists the OCR extraction in a server-side IntakeDraft and puts
// only its opaque cuid in the URL. See
// docs/intake-duplicate-handling-spec.md § "PII in URL — pattern and
// remaining follow-up" for why the previous URL-carry pattern was a
// leak and this record is the fix.
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

  // Sweep expired drafts for THIS garage before the new insert. Scoped
  // to `garageId` per AR's #3 — one busy branch never pays for
  // another's cleanup. Cheap: uses the (garageId, expiresAt) index.
  const now = new Date();
  await prisma.intakeDraft.deleteMany({
    where: { garageId: user.garageId, expiresAt: { lt: now } },
  });

  if (r.failed) {
    // Can't read the front — no point asking for the back. Go straight
    // to manual entry. No draft to persist; nothing PII in URL.
    //
    // Tier 1 taxonomy: pass the worst-case failure category as
    // `errorCode` so the confirm page's banner explains the class of
    // problem (billing → "contact owner", temporary → "try again",
    // generic → today's "couldn't read"). Absent errorCode falls back
    // to generic on the confirm page.
    const errorCode = r.errorCategory ?? "generic";
    redirect(confirmUrl({ via: "manual", error: "ocr", errorCode, assignedToId }));
  }

  // Front succeeded → persist the extraction in a fresh draft and
  // redirect to step 2 with only the opaque draft id in the URL. The
  // /back page loads the draft (garage-scoped, not-expired) and
  // renders the front-captured fields. On confirm submit, the draft
  // is deleted OUTSIDE the write transaction so a cleanup failure
  // can't roll back the job card. Two live drafts within the TTL
  // window is fine — each one is keyed by its own cuid; a fresh scan
  // gets a fresh draft with a fresh assignedToId, never inheriting.
  const draft = await prisma.intakeDraft.create({
    data: {
      garageId: user.garageId,
      createdByUserId: user.id,
      ownerName: r.fields.ownerName || null,
      plate: r.fields.plate || null,
      vin: r.fields.vin || null,
      make: r.fields.make || null,
      model: r.fields.model || null,
      year: r.fields.year ?? null,
      assignedToId: assignedToId || null,
      expiresAt: new Date(now.getTime() + INTAKE_DRAFT_TTL_MS),
    },
    select: { id: true },
  });

  redirect(`/advisor/jobs/new/back?draftId=${encodeURIComponent(draft.id)}`);
}

// ----------------------------------------------------------------------------
// Step 2 — Photograph the BACK of the Moulkia (VIN + make + model + year)
// ----------------------------------------------------------------------------
export async function moulkiaBackAction(formData: FormData) {
  const user = await requireAdvisor();

  // The draft holds the front-captured fields plus the tech assignment.
  // Nothing else rode in via URL / hidden inputs after this fix — the
  // /back page passes only the opaque draft id back through here.
  const draftId = String(formData.get("draftId") ?? "").trim();
  if (!draftId) redirect("/advisor/jobs/new?error=nofile");

  const now = new Date();
  const draft = await prisma.intakeDraft.findFirst({
    where: { id: draftId, garageId: user.garageId, expiresAt: { gt: now } },
  });
  // Stale / cross-garage / never-existed → fresh start. Never 500 on
  // a missing draft — that's a normal timeout or an abandoned tab.
  if (!draft) redirect("/advisor/jobs/new");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    // Skip the back photo — front fields become the answer as-is. No
    // update to persist; confirm page reads the draft directly.
    redirect(
      `/advisor/jobs/new/confirm?draftId=${encodeURIComponent(draft.id)}&via=moulkia&skippedBack=1`,
    );
  }
  const f = file as File;

  const base64 = Buffer.from(await f.arrayBuffer()).toString("base64");
  const mediaType = f.type || "image/jpeg";

  const r = await extractMoulkiaBack(base64, mediaType);
  await logAttempts(r.attempts, user.garageId, user.id, "BACK");

  if (r.failed) {
    // Back unreadable — front fields stay in the draft as-is. Flag on
    // confirm so the advisor knows the back gap. Carry the same
    // Tier 1 errorCode as the front path so a billing failure on the
    // back side shows "contact owner" instead of "photo unreadable".
    const errorCode = r.errorCategory ?? "generic";
    redirect(
      `/advisor/jobs/new/confirm?draftId=${encodeURIComponent(draft.id)}&via=moulkia&error=ocrBack&errorCode=${errorCode}`,
    );
  }

  // Merge front (from draft) with back (from OCR) via the same helper
  // the URL-carry version used. Back wins on overlap; front fills gaps.
  const front: MoulkiaFront = {
    ownerName: draft.ownerName ?? "",
    plate: draft.plate ?? "",
    vin: draft.vin ?? "",
    make: draft.make ?? "",
    model: draft.model ?? "",
    year: draft.year,
  };
  const merged = mergeMoulkiaFields(front, r.fields);

  await prisma.intakeDraft.update({
    where: { id: draft.id },
    data: {
      ownerName: merged.ownerName || null,
      plate: merged.plate || null,
      vin: merged.vin || null,
      make: merged.make || null,
      model: merged.model || null,
      year: merged.year ?? null,
    },
  });

  redirect(`/advisor/jobs/new/confirm?draftId=${encodeURIComponent(draft.id)}&via=moulkia`);
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
  // Draft id from the Moulkia OCR flow (front→back→confirm). Only its
  // opaque cuid rides the URL — the extracted PII lives in the
  // IntakeDraft row and is retrieved server-side by the confirm page.
  // On successful create, we delete the draft OUTSIDE the write
  // transaction so a cleanup failure can never roll back a job card
  // that was already committed (see the delete call at the tail of
  // this function).
  const draftId = get("draftId") || null;

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
      // Carry non-PII intake context forward. PII fields (ownerName,
      // phone, vin, email) are DELIBERATELY dropped — the panel does
      // a garage-scoped DB lookup for what it displays, and the
      // confirm page does the same for its defaults when vehicleId is
      // set. Anything the advisor typed for the NEW car (Choice 3
      // path) is retyped on the confirm form after picking a choice.
      // See docs/intake-duplicate-handling-spec.md — "PII in URL"
      // section — for the class of bug and the sites that carry it.
      const forward = new URLSearchParams({ via, plate });
      if (assignedToRaw) forward.set("assignedToId", assignedToRaw);
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
        publicToken: newPublicToken(),
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

  // Best-effort draft cleanup — OUTSIDE the transaction. A delete
  // failure here MUST NOT roll back a job card that was already
  // committed. Any leftover row is swept by the next
  // moulkiaFrontAction in this garage (see the deleteMany at the top)
  // or by its own TTL. Garage-scoped in the where clause so a mangled
  // draftId in the POST can't touch another tenant's row.
  if (draftId) {
    try {
      await prisma.intakeDraft.deleteMany({
        where: { id: draftId, garageId: user.garageId },
      });
    } catch {
      // swallowed intentionally — see comment above
    }
  }

  revalidatePath("/advisor");
  // Hand-off confirmation screen — explicit "you sent this to a tech" page
  // before dropping the advisor onto the job timeline. Slice 3 removed
  // the plateWarning URL param the slice-5 done page was reading; the
  // disambiguation panel intercepts BEFORE the write, so there's no
  // ambiguous state to warn about post-create.
  redirect(`/advisor/jobs/new/done?jobId=${jobId}`);
}
