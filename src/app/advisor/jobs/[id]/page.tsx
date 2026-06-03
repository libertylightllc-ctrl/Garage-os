import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { jobActionAction } from "@/app/actions/jobs";
import { createEstimateAction } from "@/app/actions/billing";
import {
  TIMELINE,
  STATUS_LABEL,
  availableActions,
  nextStatus,
  type JobAction,
  type JobStatus,
} from "@/lib/jobcard-status";

export const dynamic = "force-dynamic";

export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireRole("ADVISOR");

  const job = await prisma.jobCard.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      vehicle: { include: { customer: true } },
      estimates: {
        orderBy: { createdAt: "desc" },
        include: { invoice: { select: { id: true } } },
      },
    },
  });
  if (!job) notFound();

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
        return `Advance to ${STATUS_LABEL[nextStatus(status)!]}`;
      case "RESUME":
        return `Resume ${STATUS_LABEL[heldFrom ?? "ARRIVED"]}`;
      case "HOLD":
        return "Put on hold";
      case "REWORK":
        return "Send back to Estimate";
      case "CANCEL":
        return "Cancel job";
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <div>
        <Link href="/advisor" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          ← Active jobs
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {job.vehicle.make} {job.vehicle.model}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {job.vehicle.plate} · {job.vehicle.customer.name}
        </p>
      </div>

      {cancelled ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          🔴 This job was cancelled.
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
                {STATUS_LABEL[stage]}
                {onHold ? " — on hold" : ""}
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
        </form>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {delivered ? "🟢 Delivered — this job is complete." : "No further actions."}
        </p>
      )}

      {/* Estimates & invoicing */}
      <div className="border-t border-black/10 pt-4 dark:border-white/15">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Estimates</h2>
          <form action={createEstimateAction}>
            <input type="hidden" name="jobId" value={job.id} />
            <button className="rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
              + New estimate
            </button>
          </form>
        </div>
        {job.estimates.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No estimates yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {job.estimates.map((e) => (
              <li key={e.id} className="flex items-center justify-between">
                <Link href={`/advisor/estimates/${e.id}`} className="hover:underline">
                  Estimate · AED {Number(e.total).toFixed(2)} · {e.status}
                </Link>
                {e.invoice ? (
                  <Link href={`/invoices/${e.invoice.id}`} className="text-zinc-500 hover:underline dark:text-zinc-400">
                    invoice →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
