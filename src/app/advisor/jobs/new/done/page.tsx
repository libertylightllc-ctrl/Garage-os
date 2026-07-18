import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { JobNumberBadge } from "@/components/job-number-badge";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

/**
  * Handoff confirmation screen. Shown after createCustomerVehicleJobAction
  * creates a JobCard — the advisor needs to know the technician(s) can now
  * see the job before they drop into the timeline view.
  *
  * Why a dedicated page (not a toast on the timeline):
  * - Reception staff queue intakes back-to-back; a dedicated screen lets
  *  them confirm and immediately start another without scrolling past
  *  timeline buttons.
  * - The 'job is in the tech pool' message is the explicit handoff the
  *  workflow spec asks for — burying it inside the existing job page
  *  makes the transition invisible.
  */
export default async function HandoffDone({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string }>;
}) {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
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
  // Defense-in-depth: scope by garageId so even if assignedToId ever
  // pointed at a user in another garage (data drift, bad migration),
  // we'd render "unassigned" instead of leaking that user's name.
  const assignedTech = job.assignedToId
    ? await prisma.user.findFirst({
        where: { id: job.assignedToId, garageId: session.user.garageId },
        select: { name: true },
      })
    : null;

  const handoffMessage = assignedTech
    ? t("handoffSpecific").replace("{name}", assignedTech.name)
    : t("handoffShared");

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs"/>

      {/* Success card — the visual confirmation */}
      <section className="rounded-xl border border-success-500/40 bg-success-50 p-6 text-center dark:border-success-500/30 dark:bg-success-500/10">
        <div className="text-5xl">✅</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{t("handoffTitle")}</h1>
        <p className="mt-2 text-base text-text">{handoffMessage}</p>
      </section>

      {/* Summary of what was created — gives the advisor confidence the
          right data made it through and a quick reference if they're
          handing the keys over to a teammate. */}
      <section className="rounded-xl border border-border p-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-base">
          <dt className="text-sm font-medium text-text-mute">
            {t("handoffJobNo")}
          </dt>
          <dd className="font-semibold tabular-nums">
            <JobNumberBadge jobCard={job} />
            {job.number ? null : "—"}
          </dd>

          <dt className="text-sm font-medium text-text-mute">
            {t("secVehicle")}
          </dt>
          <dd>
            {job.vehicle.make} {job.vehicle.model}
            {job.vehicle.year ? ` (${job.vehicle.year})` :""} ·{""}
            <span className="font-medium">{job.vehicle.plate}</span>
          </dd>

          <dt className="text-sm font-medium text-text-mute">
            {t("secCustomer")}
          </dt>
          <dd>
            {job.vehicle.customer.name} · {job.vehicle.customer.phone}
          </dd>

          {job.complaint ? (
            <>
              <dt className="text-sm font-medium text-text-mute">
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
          className="inline-flex h-12 items-center justify-center rounded-lg px-5 text-center text-base font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        >
          {t("handoffCreateAnother")}
        </Link>
        <Link
          href={`/advisor/jobs/${job.id}`}
          className="rounded-lg border border-border px-5 py-3 text-center text-base font-medium"
        >
          {t("handoffViewJob")}
        </Link>
        <Link
          href="/advisor"
          className="rounded-lg px-5 py-3 text-center text-base text-text-mute hover:underline dark:text-text-mute"
        >
          {t("handoffBackToActive")}
        </Link>
      </div>
    </main>
  );
}
