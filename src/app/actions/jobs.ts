"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { transition, skipTo, type JobAction, type JobStatus } from "@/lib/jobcard-status";
import { saveUpload, validateImageUpload, AUTH_PHOTO_MAX_BYTES } from "@/lib/storage";
import { sendWhatsApp, appUrl } from "@/lib/whatsapp";
import { ensurePublicToken, newPublicToken } from "@/lib/document-tokens";
import { clampPriority } from "@/lib/priority";
import { canJoinAsHelper, canLogWork } from "@/lib/claim";
import { requireAdvisor, requireAnyRole, requireTech } from "@/lib/action-guards";
import { startWorkSession, closeJobSessions } from "@/lib/work-session";

const HOLD_REASONS = ["AWAITING_PART", "AWAITING_CUSTOMER", "OTHER"] as const;



export async function createJobCardAction(formData: FormData) {
  const user = await requireAdvisor();
  const vehicleId = String(formData.get("vehicleId") ?? "");

  // Tenant check: the vehicle's customer must belong to this advisor's garage.
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, customer: { garageId: user.garageId } },
    select: { id: true },
  });
  if (!vehicle) throw new Error("Vehicle not found in this garage");

  // Optional check-in assignment to a specific technician (else shared pool).
  const assignedToRaw = String(formData.get("assignedToId") ?? "");
  let assignedToId: string | null = null;
  if (assignedToRaw) {
    const tech = await prisma.user.findFirst({
      where: { id: assignedToRaw, garageId: user.garageId, role: "TECH" },
      select: { id: true },
    });
    assignedToId = tech?.id ?? null;
  }

  const job = await prisma.jobCard.create({
    data: {
      garageId: user.garageId,
      vehicleId: vehicle.id,
      advisorId: user.id,
      status: "ARRIVED",
      assignedToId,
      // Phase 2: fill at create so the delivery-link send never has
      // to run ensurePublicToken's safety-net update path.
      publicToken: newPublicToken(),
    },
    select: { id: true },
  });

  revalidatePath("/advisor");
  redirect(`/advisor/jobs/${job.id}`);
}

export async function jobActionAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const action = String(formData.get("action") ?? "") as JobAction;

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, status: true, heldFrom: true },
  });
  if (!job) throw new Error("Job not found in this garage");

  const next = transition(
    { status: job.status as JobStatus, heldFrom: (job.heldFrom ?? null) as JobStatus | null },
    action,
  );

  // Capture/clear the hold reason alongside the status change.
  let holdReason: (typeof HOLD_REASONS)[number] | null = null;
  let holdNote: string | null = null;
  if (action === "HOLD") {
    const r = String(formData.get("holdReason") ?? "OTHER");
    holdReason = (HOLD_REASONS as readonly string[]).includes(r)
      ? (r as (typeof HOLD_REASONS)[number])
      : "OTHER";
    holdNote = String(formData.get("holdNote") ?? "").trim() || null;
  }

  // Cancellation audit (AR 2026-08-29). Second call site into
  // status=CANCELLED — matches cancelJobAction's write shape so
  // the timeline builder finds an entry regardless of which path
  // was used. Advisor role is the actor here (cancelJobAction is
  // OWNER/MASTER). Reason is optional.
  const isCancelling = action === "CANCEL" && next.status === "CANCELLED";
  const reasonRaw = isCancelling
    ? String(formData.get("cancelReason") ?? "").trim()
    : "";
  const cancelReason = reasonRaw === "" ? null : reasonRaw;

  // Hold audit (AR 2026-08-29). heldAt + heldByUserId written on
  // every transition into ON_HOLD. holdReason + holdNote already
  // captured above. Same discipline as cancellation.
  const isHolding = action === "HOLD" && next.status === "ON_HOLD";

  await prisma.jobCard.update({
    where: { id: job.id },
    data: {
      status: next.status,
      heldFrom: next.heldFrom,
      holdReason,
      holdNote,
      ...(isCancelling
        ? {
            cancelledAt: new Date(),
            cancelledByUserId: user.id,
            cancelReason,
          }
        : {}),
      ...(isHolding
        ? {
            heldAt: new Date(),
            heldByUserId: user.id,
          }
        : {}),
    },
  });

  // Tech-tracking: a held or cancelled car is not being worked — stop
  // every open timer on it. Best-effort, never blocks the transition.
  if (next.status === "ON_HOLD" || next.status === "CANCELLED") {
    await closeJobSessions(job.id, "JOB_CLOSED");
  }

  revalidatePath(`/advisor/jobs/${job.id}`);
  revalidatePath("/advisor");
}

// Atomic claim: a single conditional UPDATE (compare-and-set). Two simultaneous claims
// are serialized by the row lock — only the one matching `claimedById: null` writes; the
// loser's WHERE matches 0 rows (count 0). No read-then-write, so no double-assignment.
export async function claimJobAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  // Two-step: claim atomically, then if the claim landed and the job was
  // still at ARRIVED, promote it to INSPECTION so the friendly status
  // changes from 'Waiting for technician' to 'Technician diagnosing' the
  // moment the tech tap-claims it. updateMany with status guard means we
  // never overwrite a hand-set ON_HOLD / ESTIMATE / etc.
  //
  // Pre-assignment guard: TECH can only claim jobs unassigned or
  // pre-assigned to them (respects the advisor's soft-assignment).
  // MASTER is the do-everything operational login (AGENTS.md) and
  // must be able to claim any waitable job — otherwise the
  // tap-to-open row on the workshop page (AR 2026-08-11 UX fix)
  // redirects to ?taken=1 whenever the car has an advisor
  // pre-assignment. Mirrors the same MASTER widening in
  // src/app/technician/page.tsx.
  const isMaster = user.role === "MASTER";
  const res = await prisma.jobCard.updateMany({
    where: {
      id: jobId,
      garageId: user.garageId,
      claimedById: null, // the guard
      status: { notIn: ["DELIVERED", "CANCELLED"] },
      ...(isMaster
        ? {}
        : { OR: [{ assignedToId: null }, { assignedToId: user.id }] }),
    },
    data: { claimedById: user.id, claimedAt: new Date() },
  });
  if (res.count > 0) {
    await prisma.jobCard.updateMany({
      where: { id: jobId, garageId: user.garageId, status: "ARRIVED" },
      data: { status: "INSPECTION" },
    });
    // Tech-tracking: claiming a car IS "I'm on this car now". Runs AFTER
    // the atomic claim (the CAS above is untouched), in its own
    // transaction, and is best-effort — a session-write failure logs but
    // never blocks the claim (see src/lib/work-session.ts contract).
    await startWorkSession(user.garageId, jobId, user.id);
  }
  revalidatePath("/technician");
  revalidatePath("/advisor");
  if (res.count === 0) redirect("/technician?taken=1"); // already taken / not eligible
  // MASTER's tap-to-open UX (AR 2026-08-11): the whole row is a submit
  // button, tapping it MEANS "open the job". TECH keeps the queue-stay
  // behavior (they may want to Take then take another) — MASTER lands
  // straight on the job card to start work.
  if (isMaster) redirect(`/technician/jobs/${jobId}`);
}

/**
 * Tech-tracking slice 1 — the ONE tap: "I'm on this car now."
 * Opens a WorkSession on this car and auto-closes the tech's previous
 * open segment (any other car). Allowed for the claimer or a joined
 * helper; tapping the car they're already on is a no-op.
 */
export async function startWorkAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: {
      id: jobId,
      garageId: user.garageId,
      status: { notIn: ["DELIVERED", "CANCELLED", "TECH_COMPLETE", "INVOICED"] },
    },
    select: { id: true, claimedById: true, helpers: { select: { techId: true } } },
  });
  if (!job) redirect("/technician?taken=1");
  if (!canLogWork(job, user.id, job.helpers.map((h) => h.techId))) {
    redirect("/technician?taken=1");
  }
  await startWorkSession(user.garageId, job.id, user.id);
  revalidatePath("/technician");
  revalidatePath("/owner");
}

/**
 * Tech adds a single extra part / issue they found mid-job. Lives as a
 * JobPart with kind=EXTRA until the tech taps 'Send for Approval' on the
 * dashboard, at which point all pending EXTRA parts roll into a new
 * draft Estimate for the cashier to price.
 *
 * Quantity is freeform but must be > 0. Price is NOT set by the tech —
 * the cashier owns pricing.
 */
export async function addExtraJobPartAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const partNoRaw = String(formData.get("partNo") ?? "").trim();
  const partNo = partNoRaw || null;
  const qtyRaw = Number(formData.get("qty") ?? 1);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.floor(qtyRaw) : 1;

  if (!description) {
    redirect(`/technician/jobs/${jobId}?error=extraDescriptionRequired`);
  }

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: {
      status: true,
      claimedById: true,
      helpers: { where: { techId: user.id }, select: { techId: true } },
    },
  });
  if (!job) throw new Error("Job not found in this garage");
  const allowed = job.claimedById === user.id || job.helpers.length > 0;
  if (!allowed) {
    redirect(`/technician/jobs/${jobId}?error=notyours`);
  }
  // Tech can only ADD extras while the originally-approved work is in
  // progress. After Send-for-Approval, status flips to
  // EXTRA_WORK_AWAITING_APPROVAL and they have to wait.
  if (job.status !== "APPROVED" && job.status !== "REPAIR") {
    redirect(`/technician/jobs/${jobId}?error=cannotAddExtra`);
  }

  await prisma.jobPart.create({
    data: {
      jobCardId: jobId,
      kind: "EXTRA",
      partNo,
      description,
      qty,
      createdById: user.id,
    },
  });
  revalidatePath("/technician");
  revalidatePath(`/technician/jobs/${jobId}`);
  redirect(`/technician/jobs/${jobId}`);
}

/**
 * Tech removes a pending extra JobPart they added by mistake. Only
 * EXTRA-kind parts are removable here, and only while the job is still in
 * the work-in-progress window (after Send-for-Approval they're rolled
 * into the estimate and become the cashier's).
 */
export async function removeExtraJobPartAction(formData: FormData) {
  const user = await requireTech();
  const jobPartId = String(formData.get("jobPartId") ?? "");
  const jobId = String(formData.get("jobId") ?? "");
  const allowed = await prisma.jobPart.findFirst({
    where: {
      id: jobPartId,
      kind: "EXTRA",
      jobCard: {
        garageId: user.garageId,
        status: { in: ["APPROVED", "REPAIR"] },
        OR: [{ claimedById: user.id }, { helpers: { some: { techId: user.id } } }],
      },
    },
    select: { id: true },
  });
  if (allowed) await prisma.jobPart.delete({ where: { id: allowed.id } });
  revalidatePath(`/technician/jobs/${jobId}`);
  redirect(`/technician/jobs/${jobId}`);
}

/**
 * Mid-Stage-7 — Tech taps 'Send for Approval' after adding extra
 * parts/issues they found while doing the approved work. The action
 * (a) rolls all pending EXTRA JobParts into a new draft Estimate so the
 * cashier can price each line, (b) deletes the JobParts since they're
 * now lines on the estimate, and (c) flips job status to
 * EXTRA_WORK_AWAITING_APPROVAL. After the customer approves the new
 * estimate, the existing setEstimateStatusAction flow sets status back
 * to APPROVED and the tech can carry on (and tap 'Mark complete' when
 * done with everything).
 *
 * Gates: must be claimer or helper, status must be APPROVED or REPAIR,
 * AND there must be at least one pending EXTRA JobPart. Other states
 * redirect with a soft error.
 */
export async function sendForReestimateAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: {
      id: true,
      status: true,
      claimedById: true,
      helpers: { where: { techId: user.id }, select: { techId: true } },
      jobParts: {
        where: { kind: "EXTRA" },
        select: { id: true, partNo: true, description: true, qty: true },
      },
    },
  });
  if (!job) throw new Error("Job not found in this garage");
  const isPrimary = job.claimedById === user.id;
  const isHelper = job.helpers.length > 0;
  if (!isPrimary && !isHelper) {
    redirect(`/technician/jobs/${jobId}?error=notyours`);
  }
  if (job.status !== "APPROVED" && job.status !== "REPAIR") {
    redirect(`/technician/jobs/${jobId}?error=cannotreestimate`);
  }
  if (job.jobParts.length === 0) {
    redirect(`/technician/jobs/${jobId}?error=noExtras`);
  }
  // Roll the pending EXTRA parts into a fresh draft Estimate inside a
  // transaction so the JobParts and the Estimate move atomically.
  await prisma.$transaction(async (tx) => {
    await tx.estimate.create({
      data: {
        jobCardId: jobId,
        subtotal: 0,
        vatAmount: 0,
        total: 0,
        status: "DRAFT",
        publicToken: newPublicToken(),
        lines: {
          create: job.jobParts.map((p) => ({
            // The cashier sets unitPrice; the tech only specifies what.
            kind: "PART",
            description: p.partNo ? `${p.partNo} — ${p.description}` : p.description,
            qty: p.qty,
            unitPrice: 0,
            lineTotal: 0,
          })),
        },
      },
    });
    await tx.jobPart.deleteMany({
      where: { id: { in: job.jobParts.map((p) => p.id) } },
    });
    await tx.jobCard.update({
      where: { id: jobId },
      data: {
        status: "EXTRA_WORK_AWAITING_APPROVAL",
        sentForReestimateAt: new Date(),
        heldFrom: null,
        holdReason: null,
        holdNote: null,
      },
    });
  });
  revalidatePath("/technician");
  revalidatePath("/cashier");
  revalidatePath("/advisor");
  revalidatePath(`/advisor/jobs/${jobId}`);
  redirect(`/technician/jobs/${jobId}/sent-for-reestimate`);
}

/**
 * Stage 7→8 — Tech taps 'Mark complete' after the approved work is done.
 * Stamps completedAt (workCompletedAt in the schema) and flips status to
 * TECH_COMPLETE, putting the job on the cashier's queue to finalise the
 * invoice. Only the claimer (or a helper joined on the job) can mark
 * complete; status must be APPROVED or REPAIR (the work-in-progress
 * window), otherwise we redirect with a soft error.
 */
export async function markCompleteAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: {
      id: true,
      status: true,
      claimedById: true,
      helpers: { where: { techId: user.id }, select: { techId: true } },
      estimates: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true },
      },
    },
  });
  if (!job) throw new Error("Job not found in this garage");
  const isPrimary = job.claimedById === user.id;
  const isHelper = job.helpers.length > 0;
  if (!isPrimary && !isHelper) {
    redirect(`/technician/jobs/${jobId}?error=notyours`);
  }
  // Stage 7 covers APPROVED (work just started) and REPAIR (actively
  // working). Anywhere else Mark-complete makes no sense.
  //
  // Desync safety: if the latest estimate is APPROVED but the jobCard
  // status never advanced past ESTIMATE (older code path / manual DB edit
  // / partial failure), still permit Mark Complete. The update below
  // writes TECH_COMPLETE which also repairs the desynced status column.
  const hasApprovedEstimate = job.estimates?.[0]?.status === "APPROVED";
  const canComplete =
    job.status === "APPROVED" ||
    job.status === "REPAIR" ||
    (job.status === "ESTIMATE" && hasApprovedEstimate);
  if (!canComplete) {
    redirect(`/technician/jobs/${jobId}?error=cannotcomplete`);
  }
  await prisma.jobCard.update({
    where: { id: jobId },
    data: {
      status: "TECH_COMPLETE",
      workCompletedAt: new Date(),
      heldFrom: null,
      holdReason: null,
      holdNote: null,
    },
  });
  // Tech-tracking: the car left active work — stop every timer on it
  // (claimer + helpers). Best-effort, never blocks the completion.
  await closeJobSessions(jobId, "COMPLETED");
  revalidatePath("/technician");
  revalidatePath("/cashier");
  revalidatePath("/advisor");
  revalidatePath(`/advisor/jobs/${jobId}`);
  redirect(`/technician/jobs/${jobId}/marked-complete`);
}

/**
 * Cancel a job — MASTER/OWNER only. Flips jobCard.status to CANCELLED so
 * the row drops off every list view (workshop, advisor queue, cashier
 * queue) but stays in the DB for audit. Best-effort closes any open
 * work sessions on the job. Used to prune stale demo/test jobs; also
 * usable when a real customer walks away pre-approval.
 */
export async function cancelJobAction(formData: FormData) {
  const user = await requireAnyRole(["OWNER", "MASTER"]);
  const jobId = String(formData.get("jobId") ?? "");
  // AR 2026-08-29 — reason is optional (nullable in the schema) but
  // captured when present so an auditor asking "why was this cancelled"
  // has an answer without having to reconstruct from context.
  const reasonRaw = String(formData.get("cancelReason") ?? "").trim();
  const cancelReason = reasonRaw === "" ? null : reasonRaw;
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, status: true },
  });
  if (!job) throw new Error("Job not found in this garage");
  // Already terminal — nothing to do. Silent no-op so the button is safe
  // to double-tap.
  if (job.status === "CANCELLED" || job.status === "DELIVERED") return;
  await prisma.jobCard.update({
    where: { id: jobId },
    data: {
      status: "CANCELLED",
      heldFrom: null,
      holdReason: null,
      holdNote: null,
      // Audit fields (AR 2026-08-29). Before this commit,
      // cancellations left no trace beyond updatedAt flipping —
      // any cancellation dated before this deploy is
      // unattributable. See docs/business-rules.md.
      cancelledAt: new Date(),
      cancelledByUserId: user.id,
      cancelReason,
    },
  });
  await closeJobSessions(jobId, "JOB_CLOSED");
  revalidatePath("/technician");
  revalidatePath("/cashier");
  revalidatePath("/advisor");
  revalidatePath(`/advisor/jobs/${jobId}`);
}

/**
 * Tech taps 'Send for Estimate' on a job they're working on. Moves the
 * job to ESTIMATE status so it appears in the advisor's pricing queue
 * (KEY DECISION #5, rev. 2026-06-23 — advisor prices estimates now),
 * and shows a confirmation screen so the tech knows the handoff happened.
 * The tech keeps the claim — it stays 'their' job, just now the advisor
 * has to set the price before any further work can happen.
 */
export async function sendForEstimateAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, status: true, claimedById: true },
  });
  if (!job) throw new Error("Job not found in this garage");
  // Only the tech who claimed it (or a helper) can send for estimate —
  // we check claimedById here; helpers are handled in the UI gate.
  if (job.claimedById !== user.id) {
    // Helper / unclaimed → reject by redirect, keep server-side simple.
    redirect(`/technician/jobs/${jobId}?error=notyours`);
  }
  // Only meaningful to send when we're in a pre-estimate stage. From
  // ESTIMATE / APPROVED / REPAIR / INVOICED / DELIVERED / CANCELLED a
  // resend would skip steps; force-redirect with a soft error.
  const sendable: string[] = ["ARRIVED", "INSPECTION", "ON_HOLD"];
  if (!sendable.includes(job.status)) {
    redirect(`/technician/jobs/${jobId}?error=alreadysent`);
  }
  await prisma.jobCard.update({
    where: { id: jobId },
    data: {
      status: "ESTIMATE",
      // Time-tracking: end of the diagnosis window, start of the pricing
      // window. Read on all three dashboards to show 'Diagnosis: 12m'.
      sentForEstimateAt: new Date(),
      heldFrom: null,
      holdReason: null,
      holdNote: null,
    },
  });
  // Tech-tracking: hand-off to the advisor pauses the wrench-time clock.
  await closeJobSessions(jobId, "SENT_FOR_ESTIMATE");
  revalidatePath("/technician");
  revalidatePath("/cashier");
  revalidatePath("/advisor");
  revalidatePath(`/advisor/jobs/${jobId}`);
  redirect(`/technician/jobs/${jobId}/sent-to-advisor`);
}

// Tier 2 #4 — a second technician joins a claimed car as a helper.
export async function joinJobAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, status: true, claimedById: true, helpers: { select: { techId: true } } },
  });
  if (!job) throw new Error("Job not found in this garage");
  const helperIds = job.helpers.map((h) => h.techId);
  if (!canJoinAsHelper(job, user.id, helperIds)) {
    redirect("/technician?taken=1");
  }
  await prisma.jobHelper.create({ data: { jobCardId: job.id, techId: user.id } });
  // Tech-tracking: joining as a helper is the helper's "I'm on this car
  // now" — best-effort, never blocks the join.
  await startWorkSession(user.garageId, job.id, user.id);
  revalidatePath("/technician");
  revalidatePath(`/technician/jobs/${job.id}`);
}

export async function leaveHelperAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  await prisma.jobHelper.deleteMany({ where: { jobCardId: jobId, techId: user.id } });
  revalidatePath("/technician");
  revalidatePath(`/technician/jobs/${jobId}`);
}

// Tier 2 #7 — advisor assigns (or clears) the bay/ramp a car occupies.
export async function setBayAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const bayRaw = String(formData.get("bayId") ?? "");
  let bayId: string | null = null;
  if (bayRaw) {
    const bay = await prisma.bay.findFirst({
      where: { id: bayRaw, garageId: user.garageId },
      select: { id: true },
    });
    bayId = bay?.id ?? null;
  }
  await prisma.jobCard.updateMany({ where: { id: jobId, garageId: user.garageId }, data: { bayId } });
  revalidatePath(`/advisor/jobs/${jobId}`);
  revalidatePath("/advisor");
}

export async function releaseJobAction(formData: FormData) {
  const user = await requireTech();
  const jobId = String(formData.get("jobId") ?? "");
  await prisma.jobCard.updateMany({
    where: { id: jobId, claimedById: user.id }, // only the claimer can release
    data: { claimedById: null, claimedAt: null },
  });
  // Close the WorkSession that was open under this claim. Without
  // this, a released job left its session running — AA0076 showed
  // 29.8h in Floor because MASTER released then re-claimed and the
  // no-op branch of startWorkSession preserved the original
  // startedAt. AR 2026-08-20 Finding 2 follow-up. Best-effort — the
  // release happens even if the session close fails (matches the
  // closeJobSessions contract in work-session.ts). A re-claim after
  // this write opens a FRESH session because the old row now has
  // endedAt set — the "already on this car" no-op filter only
  // catches OPEN sessions.
  await closeJobSessions(jobId, "JOB_CLOSED");
  revalidatePath("/technician");
}

// Advisor (re)assigns a car to a tech (or back to the shared pool). Clears any existing
// claim so the newly-assigned tech can pick it up from their Waiting list.
export async function reassignJobAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const raw = String(formData.get("assignedToId") ?? "");

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true },
  });
  if (!job) throw new Error("Job not found in this garage");

  let assignedToId: string | null = null;
  if (raw) {
    const tech = await prisma.user.findFirst({
      where: { id: raw, garageId: user.garageId, role: "TECH" },
      select: { id: true },
    });
    assignedToId = tech?.id ?? null;
  }

  await prisma.jobCard.update({
    where: { id: job.id },
    data: { assignedToId, claimedById: null, claimedAt: null },
  });
  // Same rationale as releaseJobAction — a reassignment clears the
  // claim, so any open WorkSession on the job must close too. If the
  // new tech taps 'I'm on this car' after this, startWorkSession
  // opens a fresh session (the old row's endedAt is set, so it no
  // longer matches the OPEN-only filter that drives the no-op
  // branch). AR 2026-08-20 Finding 2 follow-up. Best-effort — the
  // reassignment happens even if the session close fails.
  await closeJobSessions(job.id, "JOB_CLOSED");
  revalidatePath(`/advisor/jobs/${job.id}`);
  revalidatePath("/advisor");
  revalidatePath("/technician");
}

// Tier 3 #11 — check-in photo prompt (dispute shield). The advisor photographs the
// car at intake; reuses the existing JobStep PHOTO feed (techId null = advisor).
export async function checkInPhotoAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await jobInGarage(jobId, user.garageId);

  const f = formData.get("file");
  if (!(f instanceof File) || f.size === 0) throw new Error("No photo selected");
  // Magic-byte + MIME allowlist BEFORE storage. SVG cannot pass —
  // sniffImageType only accepts PNG/JPEG/WEBP. See storage.ts and
  // docs/upload-validation-spec.md for the attack path this closes.
  await validateImageUpload(f, { maxBytes: AUTH_PHOTO_MAX_BYTES });
  const photoUrl = await saveUpload(f, user.garageId);

  await prisma.jobStep.create({
    data: { jobCardId: job.id, type: "PHOTO", transcript: "Check-in photo", photoUrl },
  });
  revalidatePath(`/advisor/jobs/${job.id}`);
}

async function jobInGarage(jobId: string, garageId: string) {
  const job = await prisma.jobCard.findFirst({ where: { id: jobId, garageId }, select: { id: true } });
  if (!job) throw new Error("Job not found in this garage");
  return job;
}

// Tier 2 #9 — nudge a customer whose car is ready but not collected (WhatsApp).
export async function nudgeCollectionAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    // Phase 2: pull the invoice's publicToken so the wa.me link uses
    // it as the URL segment (raw token, no HMAC).
    include: { vehicle: { include: { customer: true } }, invoices: { select: { id: true, publicToken: true }, take: 1 } },
  });
  if (!job) throw new Error("Job not found in this garage");

  const customer = job.vehicle.customer;
  const inv = job.invoices[0];
  const link = inv
    ? ` ${appUrl()}/c/invoice/${await ensurePublicToken("invoice", inv)}`
    : "";
  await sendWhatsApp({
    garageId: user.garageId,
    customerId: customer.id,
    waId: customer.waId ?? customer.phone,
    template: "ready_for_collection",
    body: `Your ${job.vehicle.make} ${job.vehicle.model} is ready for collection.${link}`,
  });
  revalidatePath("/advisor/eod");
}

// Tier 2 #6 — bump a car's queue priority (VIP / emergency / fleet).
export async function setPriorityAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const priority = clampPriority(Number(formData.get("priority") ?? 0));
  await prisma.jobCard.updateMany({
    where: { id: jobId, garageId: user.garageId },
    data: { priority },
  });
  revalidatePath(`/advisor/jobs/${jobId}`);
  revalidatePath("/advisor");
  revalidatePath("/technician");
}

export async function skipToStageAction(formData: FormData) {
  const user = await requireAdvisor();
  const jobId = String(formData.get("jobId") ?? "");
  const target = String(formData.get("target") ?? "") as JobStatus;

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: user.garageId },
    select: { id: true, status: true, heldFrom: true },
  });
  if (!job) throw new Error("Job not found in this garage");

  const next = skipTo(
    { status: job.status as JobStatus, heldFrom: (job.heldFrom ?? null) as JobStatus | null },
    target,
  );
  await prisma.jobCard.update({
    where: { id: job.id },
    data: { status: next.status, heldFrom: next.heldFrom, holdReason: null, holdNote: null },
  });

  revalidatePath(`/advisor/jobs/${job.id}`);
  revalidatePath("/advisor");
}
