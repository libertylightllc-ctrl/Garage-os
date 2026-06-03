import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { STATUS_LABEL, type JobStatus } from "@/lib/jobcard-status";

export const dynamic = "force-dynamic";

export default async function TechnicianHome() {
  const session = await requireRole("TECH");

  const jobs = await prisma.jobCard.findMany({
    where: { garageId: session.user.garageId, status: { notIn: ["DELIVERED", "CANCELLED"] } },
    include: { vehicle: true },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="TECH" active="workshop" />
      <h1 className="text-2xl font-semibold tracking-tight">Workshop</h1>
      <p className="-mt-4 text-sm text-zinc-500 dark:text-zinc-400">Tap a job to work on it.</p>

      <ul className="flex flex-col gap-2">
        {jobs.length === 0 ? (
          <li className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-zinc-500 dark:border-white/20 dark:text-zinc-400">
            No active jobs right now.
          </li>
        ) : (
          jobs.map((job) => (
            <li key={job.id}>
              <Link
                href={`/technician/jobs/${job.id}`}
                className="flex items-center justify-between rounded-xl border border-black/10 p-5 text-lg hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
              >
                <span className="font-medium">
                  {job.vehicle.make} {job.vehicle.model}
                  <span className="ml-2 text-base text-zinc-500 dark:text-zinc-400">
                    {job.vehicle.plate}
                  </span>
                </span>
                <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium dark:bg-zinc-800">
                  {STATUS_LABEL[job.status as JobStatus]}
                </span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </main>
  );
}
