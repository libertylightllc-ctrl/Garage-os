import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { jobActionAction, skipToStageAction, reassignJobAction, checkInPhotoAction, setPriorityAction, setBayAction } from "@/app/actions/jobs";
import { createEstimateAction } from "@/app/actions/billing";
import { scheduleRemindersAction } from "@/app/actions/reminders";
import { recordDeliveryAction } from "@/app/actions/delivery";
import { priorityMeta } from "@/lib/priority";
import { formatJobNo } from "@/lib/jobcard-fields";
import { canRecordDelivery, deliveryStatus } from "@/lib/delivery";
import { PhotoCapture } from "@/components/photo-capture";
import { REMINDER_TYPES } from "@/lib/reminders";
import { AppNav } from "@/components/app-nav";
import { reminderTypeKey, reminderStatusKey } from "@/i18n/config";
import {
  TIMELINE,
  availableActions,
  nextStatus,
  skippableTargets,
  type JobAction,
  type JobStatus,
} from "@/lib/jobcard-status";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, fmtDateTime, countryToTimeZone } from "@/lib/format-datetime";
import { statusKey } from "@/i18n/config";
import { WorkflowStepper } from "@/components/workflow-stepper";
import { workflowStage } from "@/lib/workflow-stage";
import { buildStepperLabels } from "@/lib/workflow-stepper-labels";
import { JobTimeline } from "@/components/job-timeline";
import { loadJobTimeline } from "@/lib/job-timeline-server";
import { buildTimelineLabels } from "@/lib/job-timeline-labels";
import { jobTimeSummary } from "@/lib/work-session-reports";
import { JobTimePanel } from "@/components/job-time-panel";
import { canSeeMargin } from "@/lib/permissions";
import { computeJobProfit } from "@/lib/job-profit";
import { isReceiptReconciledOnInvoice } from "@/lib/direct-fit-receipt";
import { JobProfitCard } from "@/components/job-profit-card";

export const dynamic ="force-dynamic";

export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const t = await getT();
  const locale = await getLocale();

  const job = await prisma.jobCard.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      vehicle: { include: { customer: true } },
      // garage.country is used to derive the render timezone via
      // countryToTimeZone(). Without it every date on this page
      // rendered as UTC on Vercel — 4h behind Dubai wall clock.
      garage: { select: { country: true } },
      estimates: {
        orderBy: { createdAt:"desc"},
        include: { invoice: { select: { id: true } } },
      },
      steps: { orderBy: { createdAt:"desc"}, include: { tech: { select: { name: true } } } },
      qcBy: { select: { name: true } },
      deliveredBy: { select: { name: true } },
    },
  });
  if (!job) notFound();
  const tz = countryToTimeZone(job.garage.country);

  const techs = await prisma.user.findMany({
    where: { garageId: session.user.garageId, role:"TECH"},
    select: { id: true, name: true },
    orderBy: { name:"asc"},
  });

  // Maintenance reminders for this vehicle (Workflow-Spec step 16).
  // Phase 2 multi-tenancy: also scope on garageId — Reminder has a
  // direct garageId column, and this avoids a same-plate-different-
  // garage leak (two garages servicing cars with the same plate would
  // otherwise see each other's reminders for that vehicleId).
  const reminders = await prisma.reminder.findMany({
    where: {
      vehicleId: job.vehicleId,
      garageId: session.user.garageId,
      status: { in: ["SCHEDULED","SENT"] },
    },
    orderBy: { dueAt:"asc"},
  });
  const canScheduleReminders = job.status ==="INVOICED"|| job.status ==="DELIVERED";
  const today = new Date().toISOString().slice(0, 10);

  // Bays/ramps (Tier 2 #7) — assign this car to a physical bay.
  const bays = await prisma.bay.findMany({
    where: { garageId: session.user.garageId },
    orderBy: { name:"asc"},
    select: { id: true, name: true },
  });
  const techName = (uid: string | null) => techs.find((x) => x.id === uid)?.name;
  const claimedName = techName(job.claimedById);
  const assignedName = techName(job.assignedToId);

  // Workflow stepper state — most recent estimate (already pulled
  // desc) + invoice paid-ness from a small companion query.
  const latestEstimateStatus = job.estimates[0]?.status ?? null;
  const latestInvoice = await prisma.invoice.findFirst({
    where: { jobCardId: id },
    orderBy: { createdAt: "desc" },
    select: { total: true, payments: { select: { amount: true } } },
  });
  const invoicePaid = latestInvoice
    ? latestInvoice.payments.reduce((s, p) => s + Number(p.amount), 0) >=
      Number(latestInvoice.total) - 0.005
    : false;
  const stepperState = workflowStage({
    status: job.status,
    heldFrom: job.heldFrom,
    heldReason: job.holdReason,
    latestEstimateStatus,
    invoicePaid,
  });
  const [timelineEvents, jobTime] = await Promise.all([
    loadJobTimeline(job.id, session.user.garageId),
    jobTimeSummary(job.id),
  ]);

  // AR 2026-08-12 profit reporting Step 5 — per-job profit card on
  // the internal job page. Only rendered once an invoice exists —
  // that's when InvoiceLine.unitCost is frozen, so before that the
  // "profit" would just be an estimate against live catalog costs
  // that could still move. Post-invoice numbers are stable.
  const canShowProfit = canSeeMargin(session.user.role);
  const profitInvoice = canShowProfit
    ? await prisma.invoice.findFirst({
        where: { jobCardId: id },
        orderBy: { createdAt: "desc" },
        select: {
          lines: { select: { kind: true, qty: true, lineTotal: true, unitCost: true } },
          garage: { select: { defaultLaborHourlyCost: true } },
        },
      })
    : null;
  const profitSessions = profitInvoice
    ? await prisma.workSession.findMany({
        where: { jobCardId: id, endedAt: { not: null } },
        select: { laborCostSnapshot: true },
      })
    : [];
  // Direct-fit receipts on this job (AR 2026-08-16). Any receipt whose
  // cost we CAN'T prove landed on the frozen invoice snapshot makes
  // parts profit unreliable — the coverage rule treats it the same
  // way as a missing part cost. Detection is deterministic; see
  // isReceiptReconciledOnInvoice + docs/direct-fit-receive-spec.md.
  const profitReceipts = profitInvoice
    ? (
        await prisma.jobPartReceipt.findMany({
          where: { jobCardId: id },
          select: {
            receivedUnitCost: true,
            purchaseOrderLine: {
              select: {
                sourceEstimateLine: {
                  select: {
                    unitCost: true,
                    estimate: { select: { invoice: { select: { id: true } } } },
                  },
                },
              },
            },
          },
        })
      ).map((r) => ({
        reconciled: isReceiptReconciledOnInvoice({
          receivedUnitCost: Number(r.receivedUnitCost),
          sourceEstimateLine: r.purchaseOrderLine.sourceEstimateLine
            ? {
                unitCost:
                  r.purchaseOrderLine.sourceEstimateLine.unitCost === null
                    ? null
                    : Number(r.purchaseOrderLine.sourceEstimateLine.unitCost),
                estimateHasInvoice: Boolean(
                  r.purchaseOrderLine.sourceEstimateLine.estimate.invoice,
                ),
              }
            : null,
        }),
      }))
    : [];
  const profit = profitInvoice
    ? computeJobProfit(profitInvoice.lines, profitSessions, profitReceipts)
    : null;
  const hasLabourRate =
    profitInvoice?.garage.defaultLaborHourlyCost !== null &&
    profitInvoice?.garage.defaultLaborHourlyCost !== undefined;

  const status = job.status as JobStatus;
  const heldFrom = (job.heldFrom ?? null) as JobStatus | null;
  const refStage = status ==="ON_HOLD"? heldFrom : status;
  const curIdx = refStage ? TIMELINE.indexOf(refStage) : -1;
  const cancelled = status ==="CANCELLED";
  const delivered = status ==="DELIVERED";

  const all = availableActions({ status, heldFrom });
  // INVOICED -> DELIVERED is handled by the Delivery form (mileage-out + delivered-by),
  // so the bare ADVANCE button is hidden when the next step is delivery.
  const hideAdvance = canRecordDelivery(status);
  const primary: JobAction | null =
    all.includes("ADVANCE") && !hideAdvance
      ?"ADVANCE"
      : all.includes("RESUME")
        ?"RESUME"
        : null;
  const secondary: JobAction[] = [];
  if (all.includes("REWORK")) secondary.push("REWORK");
  else if (all.includes("HOLD")) secondary.push("HOLD");
  if (all.includes("CANCEL")) secondary.push("CANCEL");

  const label = (a: JobAction): string => {
    switch (a) {
      case "ADVANCE":
        return `${t("advanceTo")} ${t(statusKey(nextStatus(status)!))}`;
      case "RESUME":
        return `${t("resume")} ${t(statusKey(heldFrom ??"ARRIVED"))}`;
      case "HOLD":
        return t("putOnHold");
      case "REWORK":
        return t("sendBackToEstimate");
      case "CANCEL":
        return t("cancelJob");
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6 lg:max-w-6xl xl:max-w-7xl">
      <AppNav role="ADVISOR" active="jobs"/>
      <div>
        {/* pe-16 reserves room for the app-wide LangSwitcher (fixed
            end-3 top-3 in layout.tsx) so the print link isn't overlapped
            by the EN/ع pill. UNCONDITIONAL — no xl:pe-0 override — because
            the switcher is `fixed` at every viewport width (its position
            never changes with the breakpoint), and this <main> uses
            xl:max-w-7xl (1280px), so at xl the container is flush with
            the viewport edge and has no natural side margin to hand-clear
            the switcher. Marketing home CAN drop the padding at xl only
            because it uses max-w-6xl (1152px), which leaves ~64px of
            natural margin at xl+ — that assumption doesn't hold here.
            Confirmed by measurement: with xl:pe-0, print link + switcher
            physically overlap 53×14 px at 1280, 1360, and 1440 in both
            LTR and RTL. See docs/LangSwitcher-followup.md for the
            longer-term fix (move switcher into AppNav on authenticated
            pages) that would remove the need for this reservation
            entirely. */}
        <div className="flex items-start justify-between gap-3 pe-16">
          <Link href="/advisor" className="text-sm text-text-mute hover:underline">
            {t("backActiveJobs")}
          </Link>
          <Link
            href={`/advisor/jobs/${job.id}/print`}
            className="text-sm text-text-mute hover:underline"
          >
            {t("printJobCard")}
          </Link>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {priorityMeta(job.priority).badge} {job.vehicle.make} {job.vehicle.model}
        </h1>
        <p className="text-sm text-text-mute">
          {job.vehicle.plate} · {job.vehicle.customer.name}
          {formatJobNo(job.number, job.createdAt.getFullYear())
            ? ` · ${formatJobNo(job.number, job.createdAt.getFullYear())}`
            :""}
        </p>
      </div>

      <WorkflowStepper state={stepperState} labels={buildStepperLabels(t)} />

      {/* Reception detail (Job-Card-Data-Model.md) */}
      <div className="rounded-xl border border-border p-4 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          {job.complaint ? (
            <div className="col-span-2">
              <dt className="text-xs text-text-mute">{t("secComplaint")}</dt>
              <dd>{job.complaint}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-text-mute">{t("checkInLabel")}</dt>
            <dd className="tabular-nums">{fmtDateTime(job.createdAt, locale, tz)}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-mute">{t("mileageInLabel")}</dt>
            <dd>{job.mileageIn ??"—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-mute">{t("fuelLevelLabel")}</dt>
            <dd>{job.fuelLevel ? t(`fuel_${job.fuelLevel}` as never) :"—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-mute">{t("oilTypeLabel")}</dt>
            <dd>{t(`oil_${job.oilType}` as never)}</dd>
          </div>
          {job.exteriorCondition.length > 0 || job.exteriorRemarks ? (
            <div className="col-span-2">
              <dt className="text-xs text-text-mute">{t("exteriorLabel")}</dt>
              <dd>
                {job.exteriorCondition.map((v) => t(`ext_${v}` as never)).join(",")}
                {job.exteriorRemarks ? ` — ${job.exteriorRemarks}` :""}
              </dd>
            </div>
          ) : null}
          {job.interiorCondition.length > 0 || job.interiorRemarks ? (
            <div className="col-span-2">
              <dt className="text-xs text-text-mute">{t("interiorLabel")}</dt>
              <dd>
                {job.interiorCondition.map((v) => t(`int_${v}` as never)).join(",")}
                {job.interiorRemarks ? ` — ${job.interiorRemarks}` :""}
              </dd>
            </div>
          ) : null}
          {job.valuables.length > 0 ? (
            <div className="col-span-2">
              <dt className="text-xs text-text-mute">{t("secValuables")}</dt>
              <dd>
                {job.valuables.map((v) => t(`val_${v}` as never)).join(",")}
                {job.valuablesNote ? ` — ${job.valuablesNote}` :""}
              </dd>
            </div>
          ) : null}
        </dl>
        {job.qcAt ? (
          <p className="mt-2 border-t border-border pt-2 text-xs text-success-700 dark:text-success-500">
            ✅ {t("jcQc")}: {t("qcPassedBadge")} · {job.qcBy?.name ?? ""} ·{""}
            {job.qcChecks.map((c) => t(`qc_${c}` as never)).join(",")}
          </p>
        ) : null}
      </div>

      {/* Queue priority (Tier 2 #6) */}
      {!cancelled && !delivered ? (
        <form action={setPriorityAction} className="flex items-center gap-2 text-sm">
          <input type="hidden" name="jobId" value={job.id} />
          <span className="text-text-mute">{t("priorityLabel")}</span>
          <select
            name="priority"
            defaultValue={String(job.priority)}
            className="rounded-md border border-border bg-transparent px-2 py-1"
          >
            <option value="0">{t("prNormal")}</option>
            <option value="1">{t("prUrgent")}</option>
            <option value="2">{t("prEmergency")}</option>
          </select>
          <button className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors">
            {t("setPriority")}
          </button>
        </form>
      ) : null}

      {/* Bay / ramp assignment (Tier 2 #7) */}
      {!cancelled && !delivered && bays.length > 0 ? (
        <form action={setBayAction} className="flex items-center gap-2 text-sm">
          <input type="hidden" name="jobId" value={job.id} />
          <span className="text-text-mute">{t("bayLabel")}</span>
          <select
            name="bayId"
            defaultValue={job.bayId ?? ""}
            className="rounded-md border border-border bg-transparent px-2 py-1"
          >
            <option value="">{t("noBay")}</option>
            {bays.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors">
            {t("setPriority")}
          </button>
        </form>
      ) : null}

      {/* Technician assignment */}
      <div className="rounded-xl border border-border p-4 text-sm">
        <div className="mb-2">
          {t("technicianLabel")}:{""}
          <span className="font-medium">
            {claimedName
              ? `${claimedName} · ${t("working")}`
              : assignedName
                ? `${assignedName} · ${t("assignedLabel")}`
                : t("unassigned")}
          </span>
        </div>
        <form action={reassignJobAction} className="flex gap-2">
          <input type="hidden" name="jobId" value={job.id} />
          <select
            name="assignedToId"
            defaultValue={job.assignedToId ?? ""}
            className="rounded-md border border-border bg-transparent px-2 py-1"
          >
            <option value="">{t("unassigned")}</option>
            {techs.map((tech) => (
              <option key={tech.id} value={tech.id}>
                {tech.name}
              </option>
            ))}
          </select>
          <button className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors">
            {t("reassign")}
          </button>
        </form>
      </div>

      {/* Check-in photo prompt (Tier 3 #11 — dispute shield) */}
      {!cancelled && !delivered ? (
        job.steps.some((s) => s.type ==="PHOTO") ? (
          <p className="text-xs text-success-700 dark:text-success-500">📷 {t("checkInDone")}</p>
        ) : (curIdx <= TIMELINE.indexOf("INSPECTION")) ? (
          <form
            action={checkInPhotoAction}
            className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-4 text-sm"
          >
            <input type="hidden" name="jobId" value={job.id} />
            <span className="text-text">📷 {t("checkInPhotoPrompt")}</span>
            <PhotoCapture
              name="file"
              mode="preview"
              kind="photo"
              required
              buttonLabel={t("addCheckInPhoto")}
              retakeLabel={t("retake")}
              continueLabel={t("usePhoto")}
              tooBigLabel={t("fileTooBig")}
              wrongTypeLabel={t("wrongFileType")}
            />
          </form>
        ) : null
      ) : null}

      {cancelled ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {t("jobCancelled")}
        </p>
      ) : null}

      {status ==="ON_HOLD"&& job.holdReason ? (
        <p className="rounded-xl border border-warning-500/40 bg-warning-50 px-4 py-2.5 text-sm text-warning-600 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
          🟡 {t("onHold")}:{""}
          {(
            {
              AWAITING_PART: t("hrAwaitingPart"),
              AWAITING_CUSTOMER: t("hrAwaitingCustomer"),
              AWAITING_APPROVAL: t("hrAwaitingApproval"),
              OTHER: t("hrOther"),
            } as Record<string, string>
          )[job.holdReason]}
          {job.holdNote ? ` — ${job.holdNote}` :""}
        </p>
      ) : null}

      {/* Delivery — form when INVOICED, read-only summary once delivered */}
      {canRecordDelivery(status) ? (
        <form action={recordDeliveryAction} className="flex flex-col gap-2 rounded-xl border border-border p-4 text-sm">
          <input type="hidden" name="jobId" value={job.id} />
          <h2 className="text-sm font-medium">{t("jcDelivery")}</h2>
          <label className="text-xs text-text-mute">
            {t("mileageOutLabel")}
            <input
              name="mileageOut"
              type="number"
              min="0"
              required
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
          </label>
          <button className="self-start inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
            {t("markDelivered")}
          </button>
        </form>
      ) : job.deliveredAt ? (
        <div className="rounded-xl border border-border p-4 text-sm">
          <h2 className="mb-1 text-sm font-medium">{t("jcDelivery")}</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {job.mileageOut !== null ? (
              <div>
                <dt className="text-xs text-text-mute">{t("mileageOutLabel")}</dt>
                <dd>{job.mileageOut}</dd>
              </div>
            ) : null}
            {job.deliveredBy?.name ? (
              <div>
                <dt className="text-xs text-text-mute">{t("deliveredByLabel")}</dt>
                <dd>{job.deliveredBy.name}</dd>
              </div>
            ) : null}
            <div className="col-span-2">
              <dt className="text-xs text-text-mute">{t("deliveredAtLabel")}</dt>
              <dd>{fmtDateTime(job.deliveredAt, locale, tz)}</dd>
            </div>
          </dl>
          <p className={
          "mt-2 text-xs"+
            (deliveryStatus(job.deliveredAt, job.deliveryConfirmedAt) ==="CONFIRMED"
              ?"text-success-700 dark:text-success-500"
              :"text-text-mute")
          }>
            {job.deliveryConfirmedAt
              ? `✅ ${t("collectionConfirmed")} · ${fmtDateTime(job.deliveryConfirmedAt, locale, tz)}`
              : `🟡 ${t("collectionAwaiting")}`}
          </p>
        </div>
      ) : null}

      <ol className="flex flex-col gap-1">
        {TIMELINE.map((stage, i) => {
          const done = delivered || i < curIdx;
          const current = !delivered && i === curIdx;
          const onHold = current && status ==="ON_HOLD";
          const dot = cancelled
            ?"bg-border"
            : done
              ?"bg-success-500"
              : onHold
                ?"bg-warning-500"
                : current
                  ?"bg-blue-500"
                  :"bg-border";
          return (
            <li key={stage} className="flex items-center gap-3">
              <span className={`h-3 w-3 rounded-full ${dot}`} />
              <span
                className={
                  current
                    ?"font-semibold"
                    : done
                      ?"text-text-mute"
                      :"text-text-mute"
                }
              >
                {t(statusKey(stage))}
                {onHold ? ` — ${t("st_ON_HOLD")}` :""}
              </span>
            </li>
          );
        })}
      </ol>

      {all.length > 0 ? (
        <form action={jobActionAction} className="flex flex-col gap-3">
          <input type="hidden" name="jobId" value={job.id} />
          {primary ? (
            <button
              type="submit"
              name="action"
              value={primary}
              className="inline-flex h-12 items-center justify-center rounded-lg px-5 text-base font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            >
              {label(primary)}
            </button>
          ) : null}
          {secondary.length > 0 ? (
            <div className="flex gap-2">
              {secondary.map((a) => (
                <button
                  key={a}
                  type="submit"
                  name="action"
                  value={a}
                  className="flex-1 inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                >
                  {label(a)}
                </button>
              ))}
            </div>
          ) : null}
          {all.includes("HOLD") ? (
            <div className="flex flex-wrap gap-2">
              <select
                name="holdReason"
                defaultValue="AWAITING_PART"
                className="rounded-md border border-border bg-transparent px-2 py-1 text-xs"
              >
                <option value="AWAITING_PART">{t("hrAwaitingPart")}</option>
                <option value="AWAITING_CUSTOMER">{t("hrAwaitingCustomer")}</option>
                <option value="OTHER">{t("hrOther")}</option>
              </select>
              <input
                name="holdNote"
                placeholder={t("holdNote")}
                className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs"
              />
            </div>
          ) : null}
        </form>
      ) : (
        <p className="text-sm text-text-mute">
          {delivered ? t("deliveredComplete") : t("noFurtherActions")}
        </p>
      )}

      {skippableTargets(status).length > 0 ? (
        <form action={skipToStageAction} className="flex items-center gap-2 text-sm">
          <input type="hidden" name="jobId" value={job.id} />
          <span className="text-text-mute">{t("skipTo")}</span>
          <select
            name="target"
            className="rounded-md border border-border bg-transparent px-2 py-1"
          >
            {skippableTargets(status).map((s) => (
              <option key={s} value={s}>
                {t(statusKey(s))}
              </option>
            ))}
          </select>
          <button className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors">
            →
          </button>
        </form>
      ) : null}

      {/* Estimates & invoicing — KEY DECISION #5 (rev. 2026-06-23): the
          ADVISOR creates + prices the estimate after diagnosis hand-off,
          the CASHIER invoices after customer approval. The action below
          is idempotent — if a DRAFT already exists it routes there, and
          if the last estimate was REJECTED it clones the lines into a
          fresh DRAFT for re-pricing. Either way the advisor lands on
          /estimates/[id] to edit lines. */}
      <div className="border-t border-border pt-4">
        <h2 className="mb-2 text-sm font-medium">{t("estimates")}</h2>
        {/* Advisor's "your turn to price" surface — only shown when the
            advisor actually needs to act. job.estimates is orderBy
            createdAt desc so [0] is the most recent.
              - DRAFT: still editing → "Continue pricing"
              - REJECTED or none: needs a fresh draft → "Create estimate"
              - SENT (awaiting customer) or APPROVED (cashier's turn):
                suppressed — nothing for the advisor to do here. */}
        {job.status === "ESTIMATE" &&
        (!job.estimates[0] ||
          job.estimates[0].status === "DRAFT" ||
          job.estimates[0].status === "REJECTED") ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-info-500/40 bg-info-50 p-3 dark:border-info-500/30 dark:bg-info-500/10">
            <span className="text-xs text-info-600 dark:text-info-500">
              {job.estimates[0]?.status === "DRAFT"
                ? t("advisorDraftInProgress")
                : t("advisorPleasePrice")}
            </span>
            {job.estimates[0]?.status === "DRAFT" ? (
              <Link
                href={`/estimates/${job.estimates[0].id}`}
                className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
              >
                {t("continuePricing")} →
              </Link>
            ) : (
              <form action={createEstimateAction}>
                <input type="hidden" name="jobId" value={job.id} />
                <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                  {t("createEstimate")}
                </button>
              </form>
            )}
          </div>
        ) : null}
        {job.estimates.length === 0 ? (
          <p className="text-sm text-text-mute">{t("noEstimates")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {job.estimates.map((e) => (
              <li key={e.id} className="flex items-center justify-between">
                <Link href={`/estimates/${e.id}`} className="hover:underline">
                  {t("estimate")} · AED {Number(e.total).toFixed(2)} · {e.status}
                </Link>
                {e.invoice ? (
                  <Link href={`/invoices/${e.invoice.id}`} className="text-text-mute hover:underline dark:text-text-mute">
                    {t("invoiceArrow")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Maintenance reminders (Workflow-Spec step 16) */}
      {canScheduleReminders || reminders.length > 0 ? (
        <div className="border-t border-border pt-4">
          <h2 className="mb-2 text-sm font-medium">{t("remindersTitle")}</h2>

          {canScheduleReminders ? (
            <form action={scheduleRemindersAction} className="mb-3 flex flex-col gap-2 rounded-xl border border-border p-4">
              <input type="hidden" name="jobId" value={job.id} />
              <div className="text-xs text-text-mute">{t("scheduleReminders")}</div>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {REMINDER_TYPES.map((rt) => (
                  <label key={rt} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" name="types" value={rt} />
                    {t(reminderTypeKey(rt))}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-mute">{t("serviceDateLabel")}</label>
                <input
                  type="date"
                  name="serviceDate"
                  defaultValue={today}
                  className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                />
                <button className="ms-auto inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                  {t("scheduleBtn")}
                </button>
              </div>
            </form>
          ) : null}

          {reminders.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm">
              {reminders.map((r) => (
                <li key={r.id} className="flex items-center justify-between">
                  <span>🔧 {t(reminderTypeKey(r.type))}</span>
                  <span className="text-xs text-text-mute">
                    {t(reminderStatusKey(r.status))} · {fmtDate(r.dueAt, locale, tz)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Per-job profit card (advisor / owner / master only) — shown
          once the job has an invoice (that's when unitCost is frozen).
          Data-level gated by `profit` being non-null, which requires
          canSeeMargin(role) AND profitInvoice existing. */}
      {profit ? (
        <JobProfitCard profit={profit} t={t} hasLabourRate={hasLabourRate} />
      ) : null}

      <JobTimeline events={timelineEvents} labels={buildTimelineLabels(t)} />

      <JobTimePanel summary={jobTime} t={t} />

      {/* Technician activity — the live link from the workshop into this job */}
      {job.steps.length > 0 ? (
        <div className="border-t border-border pt-4">
          <h2 className="mb-2 text-sm font-medium">{t("techActivity")}</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {job.steps.map((s) => (
              <li key={s.id} className="rounded-xl border border-border p-2">
                <div className="text-text-mute">
                  {(
                    { PHOTO:"📷", VOICE:"🎤", PART_REQUEST:"📦", FINISH:"✅"} as Record<string, string>
                  )[s.type] ??"•"}{""}
                  {s.type.replace("_","").toLowerCase()} · {s.tech?.name ??"Technician"}
                </div>
                {s.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.photoUrl} alt="job photo" className="mt-1 max-h-40 rounded-md"/>
                ) : null}
                {s.voiceNoteUrl ? <audio controls src={s.voiceNoteUrl} className="mt-1 w-full"/> : null}
                {s.transcript ? <p className="text-text">{s.transcript}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </main>
  );
}
