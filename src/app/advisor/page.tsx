import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { type JobStatus } from "@/lib/jobcard-status";
import { getT } from "@/i18n/server";
import { statusKey } from "@/i18n/config";

export const dynamic = "force-dynamic";

export default async function AdvisorHome() {
  const session = await requireRole("ADVISOR");
  const t = await getT();

  const [jobs, pendingBookings, techs] = await Promise.all([
    prisma.jobCard.findMany({
      where: {
        garageId: session.user.garageId,
        status: { notIn: ["DELIVERED", "CANCELLED"] },
      },
      include: { vehicle: { include: { customer: true } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.booking.count({ where: { garageId: session.user.garageId, status: "PROPOSED" } }),
    prisma.user.findMany({
      where: { garageId: session.user.garageId, role: "TECH" },
      select: { id: true, name: true },
    }),
  ]);
  const techName = (uid: string | null) => techs.find((x) => x.id === uid)?.name;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("activeJobs")}</h1>

      <div className="flex gap-2">
        <Link
          href="/advisor/jobs/new"
          className="flex-1 rounded-lg bg-zinc-900 px-4 py-3 text-center text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {t("newJobCard")}
        </Link>
        <Link
          href="/advisor/bookings"
          className="flex-1 rounded-lg border border-black/15 px-4 py-3 text-center text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {t("newBookings")}{pendingBookings > 0 ? ` (${pendingBookings})` : ""}
        </Link>
      </div>

      <ul className="flex flex-col gap-2">
        {jobs.length === 0 ? (
          <li className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-zinc-500 dark:border-white/20 dark:text-zinc-400">
            {t("noActiveJobs")}
          </li>
        ) : (
          jobs.map((job) => (
            <li key={job.id}>
              <Link
                href={`/advisor/jobs/${job.id}`}
                className="flex items-center justify-between rounded-lg border border-black/10 p-4 hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
              >
                <span>
                  <span className="block font-medium">
                    {job.vehicle.make} {job.vehicle.model}
                    <span className="ml-2 text-sm text-zinc-500 dark:text-zinc-400">
                      {job.vehicle.plate}
                    </span>
                  </span>
                  <span className="block text-sm text-zinc-500 dark:text-zinc-400">
                    {job.vehicle.customer.name}
                    {techName(job.claimedById)
                      ? ` · 🔧 ${techName(job.claimedById)}`
                      : techName(job.assignedToId)
                        ? ` · → ${techName(job.assignedToId)}`
                        : ""}
                  </span>
                </span>
                <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium dark:bg-zinc-800">
                  {t(statusKey(job.status as JobStatus))}
                </span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </main>
  );
}
