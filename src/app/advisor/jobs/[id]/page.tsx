import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { jobActionAction, skipToStageAction, reassignJobAction, checkInPhotoAction, setPriorityAction, setBayAction } from "@/app/actions/jobs";
import { scheduleRemindersAction } from "@/app/actions/reminders";
import { priorityMeta } from "@/lib/priority";
import { formatJobNo } from "@/lib/jobcard-fields";
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
import { getT } from "@/i18n/server";
import { statusKey } from "@/i18n/config";

export const dynamic = "force-dynamic";

export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireRole("ADVISOR");
  const t = await getT();

  const job = await prisma.jobCard.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      vehicle: { include: { customer: true } },
      estimates: {
        orderBy: { createdAt: "desc" },
        include: { invoice: { select: { id: true } } },
      },
      steps: { orderBy: { createdAt: "desc" }, include: { tech: { select: { name: true } } } },
      qcBy: { select: { name: true } },
    },
  });
  if (!job) notFound();

  const techs = await prisma.user.findMany({
    where: { garageId: session.user.garageId, role: "TECH" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  // Maintenance reminders for this vehicle (Workflow-Spec step 16).
  const reminders = await prisma.reminder.findMany({
    where: { vehicleId: job.vehicleId, status: { in: ["SCHEDULED", "SENT"] } },
    orderBy: { dueAt: "asc" },
  });
  const canScheduleReminders = job.status === "INVOICED" || job.status === "DELIVERED";
  const today = new Date().toISOString().slice(0, 10);

  // Bays/ramps (Tier 2 #7) — assign this car to a physical bay.
  const bays = await prisma.bay.findMany({
    where: { garageId: session.user.garageId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const techName = (uid: string | null) => techs.find((x) => x.id === uid)?.name;
  const claimedName = techName(job.claimedById);
  const assignedName = techName(job.assignedToId);

  const status = job.status as JobStatus;
  const heldFrom = (job.heldFrom ?? null) as JobStatus | null;
  const refStage = status === "ON_HOLD" ? heldFrom : status;
  const curIdx = refStage ? TIMELINE.indexOf(refStage) : -1;
  const cancelled = status === "CANCELLED";
  const delivered = status === "DELIVERED";

  const all = availableActions({ status, heldFrom });
  const primary: JobAction | null = all.includes("ADVANCE")
    ? "ADVANCE"
    : all.includes("RESUME")
      ? "RESUME"
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
        return `${t("resume")} ${t(statusKey(heldFrom ?? "ARRIVED"))}`;
      case "HOLD":
        return t("putOnHold");
      case "REWORK":
        return t("sendBackToEstimate");
      case "CANCEL":
        return t("cancelJob");
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <div>
        <Link href="/advisor" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {priorityMeta(job.priority).badge} {job.vehicle.make} {job.vehicle.model}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {job.vehicle.plate} · {job.vehicle.customer.name}
          {formatJobNo(job.number, job.createdAt.getFullYear())
            ? ` · ${formatJobNo(job.number, job.createdAt.getFullYear())}`
            : ""}
        </p>
      </div>

      {/* Reception detail (Job-Card-Data-Model.md) */}
      <div className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          {job.complaint ? (
            <div className="col-span-2">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">{t("secComplaint")}</dt>
              <dd>{job.complaint}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">{t("mileageInLabel")}</dt>
            <dd>{job.mileageIn ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">{t("fuelLevelLabel")}</dt>
            <dd>{job.fuelLevel ? t(`fuel_${job.fuelLevel}` as never) : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">{t("oilTypeLabel")}</dt>
            <dd>{t(`oil_${job.oilType}` as never)}</dd>
          </div>
          {job.exteriorCondition.length > 0 || job.exteriorRemarks ? (
            <div className="col-span-2">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">{t("exteriorLabel")}</dt>
              <dd>
                {job.exteriorCondition.map((v) => t(`ext_${v}` as never)).join(", ")}
                {job.exteriorRemarks ? ` — ${job.exteriorRemarks}` : ""}
              </dd>
            </div>
          ) : null}
          {job.interiorCondition.length > 0 || job.interiorRemarks ? (
            <div className="col-span-2">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">{t("interiorLabel")}</dt>
              <dd>
                {job.interiorCondition.map((v) => t(`int_${v}` as never)).join(", ")}
                {job.interiorRemarks ? ` — ${job.interiorRemarks}` : ""}
              </dd>
            </div>
          ) : null}
          {job.valuables.length > 0 ? (
            <div className="col-span-2">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">{t("secValuables")}</dt>
              <dd>
                {job.valuables.map((v) => t(`val_${v}` as never)).join(", ")}
                {job.valuablesNote ? ` — ${job.valuablesNote}` : ""}
              </dd>
            </div>
          ) : null}
        </dl>
        {job.qcAt ? (
          <p className="mt-2 border-t border-black/5 pt-2 text-xs text-green-700 dark:border-white/10 dark:text-green-400">
            ✅ {t("jcQc")}: {t("qcPassedBadge")} · {job.qcBy?.name ?? ""} ·{" "}
            {job.qcChecks.map((c) => t(`qc_${c}` as never)).join(", ")}
          </p>
        ) : null}
      </div>

      {/* Queue priority (Tier 2 #6) */}
      {!cancelled && !delivered ? (
        <form action={setPriorityAction} className="flex items-center gap-2 text-sm">
          <input type="hidden" name="jobId" value={job.id} />
          <span className="text-zinc-500 dark:text-zinc-400">{t("priorityLabel")}</span>
          <select
            name="priority"
            defaultValue={String(job.priority)}
            className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
          >
            <option value="0">{t("prNormal")}</option>
            <option value="1">{t("prUrgent")}</option>
            <option value="2">{t("prEmergency")}</option>
          </select>
          <button className="rounded-md border border-black/15 px-3 py-1 font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
            {t("setPriority")}
          </button>
        </form>
      ) : null}

      {/* Bay / ramp assignment (Tier 2 #7) */}
      {!cancelled && !delivered && bays.length > 0 ? (
        <form action={setBayAction} className="flex items-center gap-2 text-sm">
          <input type="hidden" name="jobId" value={job.id} />
          <span className="text-zinc-500 dark:text-zinc-400">{t("bayLabel")}</span>
          <select
            name="bayId"
            defaultValue={job.bayId ?? ""}
            className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
          >
            <option value="">{t("noBay")}</option>
            {bays.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button className="rounded-md border border-black/15 px-3 py-1 font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
            {t("setPriority")}
          </button>
        </form>
      ) : null}

      {/* Technician assignment */}
      <div className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
        <div className="mb-2">
          {t("technicianLabel")}:{" "}
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
            className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
          >
            <option value="">{t("unassigned")}</option>
            {techs.map((tech) => (
              <option key={tech.id} value={tech.id}>
                {tech.name}
              </option>
            ))}
          </select>
          <button className="rounded-md border border-black/15 px-3 py-1 font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
            {t("reassign")}
          </button>
        </form>
      </div>

      {/* Check-in photo prompt (Tier 3 #11 — dispute shield) */}
      {!cancelled && !delivered ? (
        job.steps.some((s) => s.type === "PHOTO") ? (
          <p className="text-xs text-green-700 dark:text-green-400">📷 {t("checkInDone")}</p>
        ) : (curIdx <= TIMELINE.indexOf("INSPECTION")) ? (
          <form
            action={checkInPhotoAction}
            className="flex flex-col gap-2 rounded-lg border border-dashed border-black/20 p-3 text-sm dark:border-white/25"
          >
            <input type="hidden" name="jobId" value={job.id} />
            <span className="text-zinc-600 dark:text-zinc-300">📷 {t("checkInPhotoPrompt")}</span>
            <div className="flex items-center gap-2">
              <input type="file" name="file" accept="image/*" capture="environment" required className="flex-1 text-xs" />
              <button className="rounded-md border border-black/15 px-3 py-1 font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
                {t("addCheckInPhoto")}
              </button>
            </div>
          </form>
        ) : null
      ) : null}

      {cancelled ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {t("jobCancelled")}
        </p>
      ) : null}

      {status === "ON_HOLD" && job.holdReason ? (
        <p className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
          🟡 {t("onHold")}:{" "}
          {(
            {
              AWAITING_PART: t("hrAwaitingPart"),
              AWAITING_CUSTOMER: t("hrAwaitingCustomer"),
              AWAITING_APPROVAL: t("hrAwaitingApproval"),
              OTHER: t("hrOther"),
            } as Record<string, string>
          )[job.holdReason]}
          {job.holdNote ? ` — ${job.holdNote}` : ""}
        </p>
      ) : null}

      <ol className="flex flex-col gap-1">
        {TIMELINE.map((stage, i) => {
          const done = delivered || i < curIdx;
          const current = !delivered && i === curIdx;
          const onHold = current && status === "ON_HOLD";
          const dot = cancelled
            ? "bg-zinc-300 dark:bg-zinc-700"
            : done
              ? "bg-green-500"
              : onHold
                ? "bg-yellow-500"
                : current
                  ? "bg-blue-500"
                  : "bg-zinc-300 dark:bg-zinc-700";
          return (
            <li key={stage} className="flex items-center gap-3">
              <span className={`h-3 w-3 rounded-full ${dot}`} />
              <span
                className={
                  current
                    ? "font-semibold"
                    : done
                      ? "text-zinc-500 dark:text-zinc-400"
                      : "text-zinc-400 dark:text-zinc-600"
                }
              >
                {t(statusKey(stage))}
                {onHold ? ` — ${t("st_ON_HOLD")}` : ""}
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
              className="rounded-lg bg-zinc-900 px-4 py-4 text-base font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
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
                  className="flex-1 rounded-lg border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
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
                className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-xs dark:border-white/20"
              >
                <option value="AWAITING_PART">{t("hrAwaitingPart")}</option>
                <option value="AWAITING_CUSTOMER">{t("hrAwaitingCustomer")}</option>
                <option value="OTHER">{t("hrOther")}</option>
              </select>
              <input
                name="holdNote"
                placeholder={t("holdNote")}
                className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 text-xs dark:border-white/20"
              />
            </div>
          ) : null}
        </form>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {delivered ? t("deliveredComplete") : t("noFurtherActions")}
        </p>
      )}

      {skippableTargets(status).length > 0 ? (
        <form action={skipToStageAction} className="flex items-center gap-2 text-sm">
          <input type="hidden" name="jobId" value={job.id} />
          <span className="text-zinc-500 dark:text-zinc-400">{t("skipTo")}</span>
          <select
            name="target"
            className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
          >
            {skippableTargets(status).map((s) => (
              <option key={s} value={s}>
                {t(statusKey(s))}
              </option>
            ))}
          </select>
          <button className="rounded-md border border-black/15 px-3 py-1 font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
            →
          </button>
        </form>
      ) : null}

      {/* Estimates & invoicing — pricing is set by the cashier; the advisor sends. */}
      <div className="border-t border-black/10 pt-4 dark:border-white/15">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">{t("estimates")}</h2>
          <span className="text-xs text-zinc-400">{t("pricingByCashier")}</span>
        </div>
        {job.estimates.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("noEstimates")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {job.estimates.map((e) => (
              <li key={e.id} className="flex items-center justify-between">
                <Link href={`/estimates/${e.id}`} className="hover:underline">
                  {t("estimate")} · AED {Number(e.total).toFixed(2)} · {e.status}
                </Link>
                {e.invoice ? (
                  <Link href={`/invoices/${e.invoice.id}`} className="text-zinc-500 hover:underline dark:text-zinc-400">
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
        <div className="border-t border-black/10 pt-4 dark:border-white/15">
          <h2 className="mb-2 text-sm font-medium">{t("remindersTitle")}</h2>

          {canScheduleReminders ? (
            <form action={scheduleRemindersAction} className="mb-3 flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
              <input type="hidden" name="jobId" value={job.id} />
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{t("scheduleReminders")}</div>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {REMINDER_TYPES.map((rt) => (
                  <label key={rt} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" name="types" value={rt} />
                    {t(reminderTypeKey(rt))}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-zinc-500 dark:text-zinc-400">{t("serviceDateLabel")}</label>
                <input
                  type="date"
                  name="serviceDate"
                  defaultValue={today}
                  className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
                />
                <button className="ms-auto rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black">
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
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {t(reminderStatusKey(r.status))} · {r.dueAt.toISOString().slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Technician activity — the live link from the workshop into this job */}
      {job.steps.length > 0 ? (
        <div className="border-t border-black/10 pt-4 dark:border-white/15">
          <h2 className="mb-2 text-sm font-medium">{t("techActivity")}</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {job.steps.map((s) => (
              <li key={s.id} className="rounded-lg border border-black/10 p-2 dark:border-white/15">
                <div className="text-zinc-500 dark:text-zinc-400">
                  {(
                    { PHOTO: "📷", VOICE: "🎤", PART_REQUEST: "📦", FINISH: "✅" } as Record<string, string>
                  )[s.type] ?? "•"}{" "}
                  {s.type.replace("_", " ").toLowerCase()} · {s.tech?.name ?? "Technician"}
                </div>
                {s.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.photoUrl} alt="job photo" className="mt-1 max-h-40 rounded-md" />
                ) : null}
                {s.voiceNoteUrl ? <audio controls src={s.voiceNoteUrl} className="mt-1 w-full" /> : null}
                {s.transcript ? <p className="text-zinc-600 dark:text-zinc-300">{s.transcript}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </main>
  );
}
