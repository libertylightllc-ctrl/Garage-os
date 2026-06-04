import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { jobActionAction, skipToStageAction, reassignJobAction } from "@/app/actions/jobs";
import { AppNav } from "@/components/app-nav";
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
    },
  });
  if (!job) notFound();

  const techs = await prisma.user.findMany({
    where: { garageId: session.user.garageId, role: "TECH" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
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
          {job.vehicle.make} {job.vehicle.model}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {job.vehicle.plate} · {job.vehicle.customer.name}
        </p>
      </div>

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
