import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Confirmation screen the tech lands on after tapping 'Send for Estimate'.
 * Mirrors the advisor handoff page — explicit visual confirmation that
 * the job has moved onto the cashier so the tech can pick up the next
 * car without wondering whether the previous one made it through.
 */
export default async function SentToCashier({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRole("TECH");
  const t = await getT();
  const { id } = await params;

  const job = await prisma.jobCard.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      vehicle: { include: { customer: { select: { name: true, phone: true } } } },
    },
  });
  if (!job) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="TECH" active="workshop" />

      <section className="rounded-2xl border border-violet-500/40 bg-violet-50 p-6 text-center dark:bg-violet-950/40">
        <div className="text-5xl">💸</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {t("sentToCashierTitle")}
        </h1>
        <p className="mt-2 text-base text-zinc-700 dark:text-zinc-200">
          {t("sentToCashierSubtitle")}
        </p>
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-base">
          <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {t("handoffJobNo")}
          </dt>
          <dd className="font-semibold tabular-nums">#{job.number ?? "—"}</dd>

          <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {t("secVehicle")}
          </dt>
          <dd>
            {job.vehicle.make} {job.vehicle.model}
            {job.vehicle.year ? ` (${job.vehicle.year})` : ""} ·{" "}
            <span className="font-medium">{job.vehicle.plate}</span>
          </dd>

          <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {t("secCustomer")}
          </dt>
          <dd>
            {job.vehicle.customer.name} · {job.vehicle.customer.phone}
          </dd>
        </dl>
      </section>

      <div className="flex flex-col gap-2">
        <Link
          href="/technician"
          className="rounded-lg bg-zinc-900 px-5 py-3 text-center text-base font-semibold text-white dark:bg-white dark:text-black"
        >
          {t("sentToCashierBackToWorkshop")}
        </Link>
        <Link
          href={`/technician/jobs/${job.id}`}
          className="rounded-lg border border-black/15 px-5 py-3 text-center text-base font-medium dark:border-white/20"
        >
          {t("sentToCashierViewJob")}
        </Link>
      </div>
    </main>
  );
}
