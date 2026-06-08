import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Handoff confirmation screen. Shown after createCustomerVehicleJobAction
 * creates a JobCard — the advisor needs to know the technician(s) can now
 * see the job before they drop into the timeline view.
 *
 * Why a dedicated page (not a toast on the timeline):
 *  - Reception staff queue intakes back-to-back; a dedicated screen lets
 *    them confirm and immediately start another without scrolling past
 *    timeline buttons.
 *  - The 'job is in the tech pool' message is the explicit handoff the
 *    workflow spec asks for — burying it inside the existing job page
 *    makes the transition invisible.
 */
export default async function HandoffDone({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string }>;
}) {
  const session = await requireRole("ADVISOR");
  const t = await getT();
  const { jobId } = await searchParams;
  if (!jobId) notFound();

  const job = await prisma.jobCard.findFirst({
    where: { id: jobId, garageId: session.user.garageId },
    include: {
      vehicle: { include: { customer: { select: { name: true, phone: true } } } },
    },
  });
  if (!job) notFound();

  // assignedToId is a raw column (no Prisma relation) — look the tech up
  // separately so we can name them on the confirmation screen.
  const assignedTech = job.assignedToId
    ? await prisma.user.findUnique({
        where: { id: job.assignedToId },
        select: { name: true },
      })
    : null;

  const handoffMessage = assignedTech
    ? t("handoffSpecific").replace("{name}", assignedTech.name)
    : t("handoffShared");

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />

      {/* Success card — the visual confirmation */}
      <section className="rounded-2xl border border-emerald-500/40 bg-emerald-50 p-6 text-center dark:bg-emerald-950/40">
        <div className="text-5xl">✅</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{t("handoffTitle")}</h1>
        <p className="mt-2 text-base text-zinc-700 dark:text-zinc-200">{handoffMessage}</p>
      </section>

      {/* Summary of what was created — gives the advisor confidence the
          right data made it through and a quick reference if they're
          handing the keys over to a teammate. */}
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

          {job.complaint ? (
            <>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {t("secComplaint")}
              </dt>
              <dd>{job.complaint}</dd>
            </>
          ) : null}
        </dl>
      </section>

      {/* The two next-step actions, sized as full tap targets. 'Create
          another' is on the right (primary forward motion); 'View job'
          is the secondary path for advisors who want to add notes. */}
      <div className="flex flex-col gap-2">
        <Link
          href="/advisor/jobs/new"
          className="rounded-lg bg-zinc-900 px-5 py-3 text-center text-base font-semibold text-white dark:bg-white dark:text-black"
        >
          {t("handoffCreateAnother")}
        </Link>
        <Link
          href={`/advisor/jobs/${job.id}`}
          className="rounded-lg border border-black/15 px-5 py-3 text-center text-base font-medium dark:border-white/20"
        >
          {t("handoffViewJob")}
        </Link>
        <Link
          href="/advisor"
          className="rounded-lg px-5 py-3 text-center text-base text-zinc-500 hover:underline dark:text-zinc-400"
        >
          {t("handoffBackToActive")}
        </Link>
      </div>
    </main>
  );
}
