import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { statusKey } from "@/i18n/config";
import { type JobStatus } from "@/lib/jobcard-status";
import { priorityMeta } from "@/lib/priority";
import { claimJobAction, releaseJobAction } from "@/app/actions/jobs";

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

  const [waiting, mine] = await Promise.all([
    prisma.jobCard.findMany({
      where: {
        garageId,
        claimedById: null,
        status: { notIn: ["DELIVERED", "CANCELLED"] },
        OR: [{ assignedToId: null }, { assignedToId: me }],
      },
      include: { vehicle: true },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    }),
    prisma.jobCard.findMany({
      where: { garageId, claimedById: me, status: { notIn: ["DELIVERED", "CANCELLED"] } },
      include: { vehicle: true },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  const inProgress = mine.filter((j) => j.status !== "ON_HOLD");
  const paused = mine.filter((j) => j.status === "ON_HOLD");
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
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {t(statusKey(j.status as JobStatus))}
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
            {inProgress.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between rounded-xl border border-black/10 p-4 dark:border-white/15"
              >
                <Link href={`/technician/jobs/${j.id}`} className="text-lg font-medium hover:underline">
                  {carLine(j)}
                </Link>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/technician/jobs/${j.id}`}
                    className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
                  >
                    {t("open")}
                  </Link>
                  <form action={releaseJobAction}>
                    <input type="hidden" name="jobId" value={j.id} />
                    <button className="rounded-lg border border-black/15 px-4 py-2 text-sm dark:border-white/20">
                      {t("releaseCar")}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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
