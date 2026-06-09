import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { type JobStatus } from "@/lib/jobcard-status";
import { priorityMeta } from "@/lib/priority";
import {
  claimJobAction,
  releaseJobAction,
  joinJobAction,
  sendForEstimateAction,
  markCompleteAction,
} from "@/app/actions/jobs";
import { friendlyStatus } from "@/lib/jobcard-status";
import { FriendlyStatusBadge } from "@/components/friendly-status-badge";
import { JobTimings } from "@/components/job-timings";

export const dynamic = "force-dynamic";

export default async function TechnicianHome({
  searchParams,
}: {
  searchParams: Promise<{ taken?: string }>;
}) {
  const session = await requireRole("TECH");
  const t = await getT();
  const { taken } = await searchParams;
  const me = session.user.id;
  const garageId = session.user.garageId;

  const [waiting, mine, others] = await Promise.all([
    prisma.jobCard.findMany({
      where: {
        garageId,
        claimedById: null,
        status: { notIn: ["DELIVERED", "CANCELLED"] },
        OR: [{ assignedToId: null }, { assignedToId: me }],
      },
      include: {
        vehicle: true,
        // waiting-pool jobs are typically ARRIVED so an estimate is rare,
        // but keep the field available so the FriendlyStatusBadge call
        // below renders correctly in the edge case where a tech released
        // a job that already had an estimate.
        estimates: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    }),
    // Mine = jobs I claimed (primary) OR jobs I'm helping on.
    prisma.jobCard.findMany({
      where: {
        garageId,
        status: { notIn: ["DELIVERED", "CANCELLED"] },
        OR: [{ claimedById: me }, { helpers: { some: { techId: me } } }],
      },
      include: {
        vehicle: true,
        // For the per-row timing captions (Diagnosis + Pricing) AND for
        // the friendly badge — status drives ESTIMATE_UNDER_PROCESS vs.
        // AWAITING_CUSTOMER_APPROVAL on Stage 6 jobs.
        estimates: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true, sentAt: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    // Other techs' in-progress cars I could join as a helper (Tier 2 #4).
    prisma.jobCard.findMany({
      where: {
        garageId,
        status: { notIn: ["DELIVERED", "CANCELLED"] },
        claimedById: { not: null, notIn: [me] },
        helpers: { none: { techId: me } },
      },
      include: { vehicle: true },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    }),
  ]);

  const techNames = new Map(
    (await prisma.user.findMany({ where: { garageId, role: "TECH" }, select: { id: true, name: true } })).map(
      (u) => [u.id, u.name] as const,
    ),
  );

  const inProgress = mine.filter((j) => j.status !== "ON_HOLD");
  const paused = mine.filter((j) => j.status === "ON_HOLD");
  const now = new Date();
  const amHelper = (j: { claimedById: string | null }) => j.claimedById !== me;
  const reasonLabel = (r: string | null) =>
    (
      {
        AWAITING_PART: t("hrAwaitingPart"),
        AWAITING_CUSTOMER: t("hrAwaitingCustomer"),
        AWAITING_APPROVAL: t("hrAwaitingApproval"),
        OTHER: t("hrOther"),
      } as Record<string, string>
    )[r ?? "OTHER"];

  const carLine = (j: { vehicle: { make: string; model: string; plate: string } }) =>
    `${j.vehicle.make} ${j.vehicle.model} · ${j.vehicle.plate}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="TECH" active="workshop" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("tabWorkshop")}</h1>

      {taken ? (
        <p className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
          {t("alreadyTaken")}
        </p>
      ) : null}

      {/* Waiting pool */}
      <section>
        <h2 className="mb-2 text-sm font-medium">{t("waiting")}</h2>
        {waiting.length === 0 ? (
          <p className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-zinc-500 dark:border-white/20 dark:text-zinc-400">
            {t("noWaiting")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {waiting.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between rounded-xl border border-black/10 p-4 dark:border-white/15"
              >
                <span>
                  <span className="block text-lg font-medium">
                    {priorityMeta(j.priority).badge} {carLine(j)}
                  </span>
                  <span className="mt-1 inline-flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <FriendlyStatusBadge
                      status={friendlyStatus({
                        status: j.status as JobStatus,
                        claimedById: j.claimedById,
                        latestEstimateStatus: (j.estimates?.[0]?.status ?? null) as
                          | "DRAFT" | "SENT" | "APPROVED" | "REJECTED" | null,
                      })}
                      t={t}
                      size="sm"
                    />
                    {j.assignedToId === me ? ` · ${t("forYou")}` : ""}
                  </span>
                </span>
                <form action={claimJobAction}>
                  <input type="hidden" name="jobId" value={j.id} />
                  <button className="rounded-lg bg-zinc-900 px-5 py-3 text-base font-semibold text-white dark:bg-white dark:text-black">
                    {t("take")}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* My in-progress */}
      <section>
        <h2 className="mb-2 text-sm font-medium">{t("inProgressMine")}</h2>
        {inProgress.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">—</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {inProgress.map((j) => {
              // 'Send for Estimate' is only meaningful while the tech is
              // still diagnosing — after ESTIMATE/APPROVED/REPAIR the job
              // has moved on. Helpers can't send; only the claimer.
              const canSendForEstimate =
                !amHelper(j) &&
                (j.status === "ARRIVED" || j.status === "INSPECTION");
              // 'Mark complete' replaces it once the customer has approved
              // and work is happening (Stage 7). Helpers can also tap
              // (sometimes they finish the car while the primary's on lunch).
              const canMarkComplete =
                j.status === "APPROVED" || j.status === "REPAIR";
              return (
                <li
                  key={j.id}
                  className="flex flex-col gap-2 rounded-xl border border-black/10 p-4 dark:border-white/15"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/technician/jobs/${j.id}`}
                      className="text-lg font-medium hover:underline"
                    >
                      {priorityMeta(j.priority).badge} {carLine(j)}
                      {amHelper(j) ? (
                        <span className="ms-2 text-xs text-zinc-500 dark:text-zinc-400">
                          · {t("helpingTag")}
                        </span>
                      ) : null}
                    </Link>
                    <FriendlyStatusBadge
                      status={friendlyStatus({
                        status: j.status as JobStatus,
                        claimedById: j.claimedById,
                        latestEstimateStatus: (j.estimates?.[0]?.status ?? null) as
                          | "DRAFT" | "SENT" | "APPROVED" | "REJECTED" | null,
                      })}
                      t={t}
                      size="sm"
                    />
                  </div>
                  <JobTimings
                    claimedAt={j.claimedAt}
                    sentForEstimateAt={j.sentForEstimateAt}
                    estimateSentAt={j.estimates?.[0]?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/technician/jobs/${j.id}`}
                      className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
                    >
                      {t("open")}
                    </Link>
                    {canSendForEstimate ? (
                      <form action={sendForEstimateAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <button className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">
                          {t("sendForEstimate")}
                        </button>
                      </form>
                    ) : null}
                    {canMarkComplete ? (
                      <form action={markCompleteAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <button className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500">
                          {t("markCompleteAndSend")}
                        </button>
                      </form>
                    ) : null}
                    {amHelper(j) ? null : (
                      <form action={releaseJobAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <button className="rounded-lg border border-black/15 px-4 py-2 text-sm dark:border-white/20">
                          {t("releaseCar")}
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Other techs' jobs — join as a helper (Tier 2 #4) */}
      {others.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium">{t("otherInProgress")}</h2>
          <ul className="flex flex-col gap-2">
            {others.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between rounded-xl border border-black/10 p-4 dark:border-white/15"
              >
                <span>
                  <span className="block font-medium">
                    {priorityMeta(j.priority).badge} {carLine(j)}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    🔧 {techNames.get(j.claimedById ?? "") ?? "—"}
                  </span>
                </span>
                <form action={joinJobAction}>
                  <input type="hidden" name="jobId" value={j.id} />
                  <button className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
                    {t("joinJob")}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Paused (leaves active work, stays visible & flagged) */}
      {paused.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium">{t("paused")}</h2>
          <ul className="flex flex-col gap-2">
            {paused.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between rounded-xl border border-yellow-300 bg-yellow-50 p-4 dark:border-yellow-800 dark:bg-yellow-950"
              >
                <span>
                  <span className="block text-lg font-medium">{carLine(j)}</span>
                  <span className="text-xs text-yellow-800 dark:text-yellow-300">
                    🟡 {reasonLabel(j.holdReason)}
                  </span>
                </span>
                <Link
                  href={`/technician/jobs/${j.id}`}
                  className="rounded-lg border border-black/15 px-4 py-2 text-sm dark:border-white/20"
                >
                  {t("open")}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
