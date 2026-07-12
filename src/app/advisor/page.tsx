import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { friendlyStatus, type JobStatus } from "@/lib/jobcard-status";
import { priorityMeta } from "@/lib/priority";
import { getT } from "@/i18n/server";
import { FriendlyStatusBadge } from "@/components/friendly-status-badge";
import { JobTimings } from "@/components/job-timings";
import { ButtonLink } from "@/components/ui/button";

export const dynamic ="force-dynamic";

export default async function AdvisorHome() {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const t = await getT();

  // Explicit select on JobCard to bypass the 'missing column in
  // live DB' risk that's been blocking the vehicle-history page.
  // Only the fields the page render actually reads are listed —
  // ANY column in the Prisma schema that isn't in the live DB no
  // longer takes this page down.
  const [jobs, pendingBookings, techs] = await Promise.all([
    prisma.jobCard.findMany({
      where: {
        garageId: session.user.garageId,
        status: { notIn: ["DELIVERED","CANCELLED"] },
      },
      select: {
        id: true,
        status: true,
        priority: true,
        claimedById: true,
        claimedAt: true,
        assignedToId: true,
        sentForEstimateAt: true,
        holdReason: true,
        vehicle: { select: { make: true, model: true, plate: true, customer: { select: { name: true } } } },
        estimates: {
          orderBy: { createdAt:"desc"},
          take: 1,
          select: { status: true, sentAt: true, createdAt: true },
        },
        invoices: {
          orderBy: { issuedAt:"desc"},
          take: 1,
          select: {
            total: true,
            payments: { select: { amount: true } },
          },
        },
      },
      orderBy: [{ priority:"desc"}, { updatedAt:"desc"}],
    }),
    prisma.booking.count({ where: { garageId: session.user.garageId, status:"PROPOSED"} }),
    prisma.user.findMany({
      where: { garageId: session.user.garageId, role:"TECH"},
      select: { id: true, name: true },
    }),
  ]);
  const techName = (uid: string | null) => techs.find((x) => x.id === uid)?.name;
  // Server-side 'now' for the in-progress duration captions (no client clock
  // — every row reads from the same wall time on render).
  const now = new Date();
  const reasonLabel = (r: string | null) =>
    (
      {
        AWAITING_PART: t("hrAwaitingPart"),
        AWAITING_CUSTOMER: t("hrAwaitingCustomer"),
        AWAITING_APPROVAL: t("hrAwaitingApproval"),
        OTHER: t("hrOther"),
      } as Record<string, string>
    )[r ??"OTHER"];

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("activeJobs")}</h1>

      <div className="flex flex-wrap gap-2">
        {/* HERO — the advisor's primary action on this overview screen */}
        <ButtonLink href="/advisor/jobs/new" variant="hero" size="lg" className="flex-1">
          {t("newJobCard")}
        </ButtonLink>
        <ButtonLink href="/advisor/bookings" size="lg" className="flex-1">
          {t("newBookings")}{pendingBookings > 0 ? ` (${pendingBookings})` :""}
        </ButtonLink>
        <ButtonLink href="/advisor/eod" size="lg" className="flex-1">
          {t("tabEod")}
        </ButtonLink>
      </div>

      <ul className="flex flex-col gap-2">
        {jobs.length === 0 ? (
          <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
            {t("noActiveJobs")}
          </li>
        ) : (
          jobs.map((job) => (
            <li key={job.id}>
              <Link
                href={`/advisor/jobs/${job.id}`}
                className="flex items-center justify-between rounded-xl border border-border p-4 hover:bg-surface-2 transition-colors"
              >
                <span>
                  <span className="block font-medium">
                    {priorityMeta(job.priority).badge} {job.vehicle.make} {job.vehicle.model}
                    <span className="ml-2 text-sm text-text-mute">
                      {job.vehicle.plate}
                    </span>
                  </span>
                  <span className="block text-sm text-text-mute">
                    {job.vehicle.customer.name}
                    {techName(job.claimedById)
                      ? ` · 🔧 ${techName(job.claimedById)}`
                      : techName(job.assignedToId)
                        ? ` · → ${techName(job.assignedToId)}`
                        :""}
                  </span>
                  <JobTimings
                    claimedAt={job.claimedAt}
                    sentForEstimateAt={job.sentForEstimateAt}
                    estimateSentAt={job.estimates[0]?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                </span>
                {/* Friendly status badge — same component on every dashboard
                    so the advisor, tech, and cashier see the same wording.
                    On hold gets the hold reason as a small caption below. */}
                <span className="flex flex-col items-end gap-1">
                  {(() => {
                    const inv = job.invoices[0];
                    const paidTotal = inv
                      ? inv.payments.reduce((s, p) => s + Number(p.amount), 0)
                      : 0;
                    const invoicePaidInFull = inv ? paidTotal >= Number(inv.total) : false;
                    return (
                      <FriendlyStatusBadge
                        status={friendlyStatus({
                          status: job.status as JobStatus,
                          claimedById: job.claimedById,
                          latestEstimateStatus: (job.estimates[0]?.status ?? null) as
                            |"DRAFT"|"SENT"|"APPROVED"|"REJECTED"| null,
                          invoicePaidInFull,
                        })}
                        t={t}
                        size="sm"
                      />
                    );
                  })()}
                  {job.status ==="ON_HOLD"? (
                    <span className="text-xs text-text-mute">
                      {reasonLabel(job.holdReason)}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </main>
  );
}
