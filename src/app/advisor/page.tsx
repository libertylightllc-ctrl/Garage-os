import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { friendlyStatus, type JobStatus } from "@/lib/jobcard-status";
import { priorityMeta } from "@/lib/priority";
import { getT } from "@/i18n/server";
import { FriendlyStatusBadge } from "@/components/friendly-status-badge";
import { JobTimings } from "@/components/job-timings";

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
      include: {
        vehicle: { include: { customer: true } },
        // Latest estimate so the friendly badge can distinguish
        // 'Estimate under process' from 'Awaiting customer approval',
        // plus sentAt for the pricing-duration display.
        estimates: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true, sentAt: true, createdAt: true },
        },
        // Latest invoice + its payments so the badge can swing from
        // 'Awaiting payment' to 'Ready for pickup' once the customer
        // has paid in full (Stage 9 → 10).
        invoices: {
          orderBy: { issuedAt: "desc" },
          take: 1,
          select: {
            total: true,
            payments: { select: { amount: true } },
          },
        },
      },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    }),
    prisma.booking.count({ where: { garageId: session.user.garageId, status: "PROPOSED" } }),
    prisma.user.findMany({
      where: { garageId: session.user.garageId, role: "TECH" },
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
    )[r ?? "OTHER"];

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
        <Link
          href="/advisor/eod"
          className="flex-1 rounded-lg border border-black/15 px-4 py-3 text-center text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {t("tabEod")}
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
                    {priorityMeta(job.priority).badge} {job.vehicle.make} {job.vehicle.model}
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
                            | "DRAFT" | "SENT" | "APPROVED" | "REJECTED" | null,
                          invoicePaidInFull,
                        })}
                        t={t}
                        size="sm"
                      />
                    );
                  })()}
                  {job.status === "ON_HOLD" ? (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
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
