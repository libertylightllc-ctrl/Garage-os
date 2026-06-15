import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { durationBetween } from "@/lib/duration";

export const dynamic = "force-dynamic";

/**
 * Confirmation screen after the tech taps 'Mark complete'. Mirrors the
 * sent-to-cashier handoff visual so the staff workflow always lands on
 * an explicit "this stage is done" page before moving on.
 */
export default async function MarkedComplete({
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

  // Useful at-a-glance: how long the approved work took (REPAIR window).
  // sentForEstimateAt → workCompletedAt covers diagnose+price+approve+work,
  // so we lean on the simpler approved → workCompletedAt window when an
  // estimate exists. Skip if data missing.
  const approvedEstimate = await prisma.estimate.findFirst({
    where: { jobCardId: job.id, status: "APPROVED" },
    orderBy: { approvedAt: "desc" },
    select: { approvedAt: true },
  });
  const repairWindow = durationBetween(approvedEstimate?.approvedAt ?? null, job.workCompletedAt);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="TECH" active="workshop" />

      <section className="rounded-xl border border-info-500/40 bg-info-50 p-6 text-center dark:border-info-500/30 dark:bg-info-500/10">
        <div className="text-5xl">🔧</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {t("markedCompleteTitle")}
        </h1>
        <p className="mt-2 text-base text-text">
          {t("markedCompleteSubtitle")}
        </p>
      </section>

      <section className="rounded-xl border border-border p-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-base">
          <dt className="text-sm font-medium text-text-mute">
            {t("handoffJobNo")}
          </dt>
          <dd className="font-semibold tabular-nums">#{job.number ?? "—"}</dd>

          <dt className="text-sm font-medium text-text-mute">
            {t("secVehicle")}
          </dt>
          <dd>
            {job.vehicle.make} {job.vehicle.model}
            {job.vehicle.year ? ` (${job.vehicle.year})` : ""} ·{" "}
            <span className="font-medium">{job.vehicle.plate}</span>
          </dd>

          <dt className="text-sm font-medium text-text-mute">
            {t("secCustomer")}
          </dt>
          <dd>
            {job.vehicle.customer.name} · {job.vehicle.customer.phone}
          </dd>

          {job.workCompletedAt ? (
            <>
              <dt className="text-sm font-medium text-text-mute">
                {t("markedCompleteCompletedAt")}
              </dt>
              <dd className="tabular-nums">
                {job.workCompletedAt.toISOString().slice(0, 16).replace("T", " ")}
                {repairWindow ? ` · ${repairWindow}` : ""}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      <div className="flex flex-col gap-2">
        <Link
          href="/technician"
          className="inline-flex h-12 items-center justify-center rounded-lg px-5 text-center text-base font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        >
          {t("sentToCashierBackToWorkshop")}
        </Link>
        <Link
          href={`/technician/jobs/${job.id}`}
          className="rounded-lg border border-border px-5 py-3 text-center text-base font-medium "
        >
          {t("sentToCashierViewJob")}
        </Link>
      </div>
    </main>
  );
}
