import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { type JobStatus } from "@/lib/jobcard-status";
import { priorityMeta } from "@/lib/priority";
import {
  claimJobAction,
  joinJobAction,
  sendForEstimateAction,
  sendForReestimateAction,
} from "@/app/actions/jobs";
import { friendlyStatus } from "@/lib/jobcard-status";
import { FriendlyStatusBadge } from "@/components/friendly-status-badge";
import { JobTimings } from "@/components/job-timings";

export const dynamic ="force-dynamic";

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
        // Same terminal exclusions as the other two queries so a job
        // can never reappear in the waiting pool via some backwards
        // status flip on a completed car. Per spec: 'Once a job reaches
        // INVOICED or later, remove it from every technician list.'
        // TECH_COMPLETE is also excluded here for symmetry — once the
        // tech has marked complete, no further claim is meaningful.
        status: {
          notIn: ["TECH_COMPLETE","INVOICED","DELIVERED","CANCELLED"],
        },
        OR: [{ assignedToId: null }, { assignedToId: me }],
      },
      include: {
        vehicle: true,
        // waiting-pool jobs are typically ARRIVED so an estimate is rare,
        // but keep the field available so the FriendlyStatusBadge call
        // below renders correctly in the edge case where a tech released
        // a job that already had an estimate.
        estimates: { orderBy: { createdAt:"desc"}, take: 1, select: { status: true } },
      },
      orderBy: [{ priority:"desc"}, { createdAt:"asc"}],
    }),
    // Mine = jobs I claimed (primary) OR jobs I'm helping on.
    prisma.jobCard.findMany({
      where: {
        garageId,
        // Per spec: once the tech taps 'Finish' (status → TECH_COMPLETE),
        // the job leaves their dashboard — it's the cashier's now. Same
        // applies once the invoice is out (INVOICED). DELIVERED/CANCELLED
        // were already excluded.
        status: { notIn: ["TECH_COMPLETE","INVOICED","DELIVERED","CANCELLED"] },
        OR: [{ claimedById: me }, { helpers: { some: { techId: me } } }],
      },
      include: {
        vehicle: true,
        estimates: {
          orderBy: { createdAt:"desc"},
          take: 1,
          select: { status: true, sentAt: true },
        },
        invoices: {
          orderBy: { issuedAt:"desc"},
          take: 1,
          select: {
            total: true,
            payments: { select: { amount: true } },
          },
        },
        // Pending EXTRA parts drive the Send-for-Approval button visibility.
        // REQUIRED parts drive the Open ↔ Send-for-Estimate switch during
        // the diagnosis stage. Both are counted from the same row.
        jobParts: { select: { id: true, kind: true } },
      },
      orderBy: { updatedAt:"desc"},
    }),
    // Other techs' in-progress cars I could join as a helper (Tier 2 #4).
    prisma.jobCard.findMany({
      where: {
        garageId,
        // Same exclusions as 'mine' — once a job hits TECH_COMPLETE the
        // shop's tech population has nothing left to do with it.
        status: { notIn: ["TECH_COMPLETE","INVOICED","DELIVERED","CANCELLED"] },
        claimedById: { not: null, notIn: [me] },
        helpers: { none: { techId: me } },
      },
      include: { vehicle: true },
      orderBy: [{ priority:"desc"}, { updatedAt:"desc"}],
    }),
  ]);

  const techNames = new Map(
    (await prisma.user.findMany({ where: { garageId, role:"TECH"}, select: { id: true, name: true } })).map(
      (u) => [u.id, u.name] as const,
    ),
  );

  const inProgress = mine.filter((j) => j.status !=="ON_HOLD");
  const paused = mine.filter((j) => j.status ==="ON_HOLD");
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
    )[r ??"OTHER"];

  const carLine = (j: { vehicle: { make: string; model: string; plate: string } }) =>
    `${j.vehicle.make} ${j.vehicle.model} · ${j.vehicle.plate}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="TECH" active="workshop"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("tabWorkshop")}</h1>

      {taken ? (
        <p className="rounded-xl border border-warning-500/40 bg-warning-50 px-4 py-2.5 text-sm text-warning-600 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
          {t("alreadyTaken")}
        </p>
      ) : null}

      {/* Waiting pool */}
      <section>
        <h2 className="mb-2 text-sm font-medium">{t("waiting")}</h2>
        {waiting.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
            {t("noWaiting")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {waiting.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between rounded-xl border border-border p-4"
              >
                <span>
                  <span className="block text-lg font-medium">
                    {priorityMeta(j.priority).badge} {carLine(j)}
                  </span>
                  <span className="mt-1 inline-flex items-center gap-2 text-xs text-text-mute">
                    <FriendlyStatusBadge
                      status={friendlyStatus({
                        status: j.status as JobStatus,
                        claimedById: j.claimedById,
                        latestEstimateStatus: (j.estimates?.[0]?.status ?? null) as
                          |"DRAFT"|"SENT"|"APPROVED"|"REJECTED"| null,
                      })}
                      t={t}
                      size="sm"
                    />
                    {j.assignedToId === me ? ` · ${t("forYou")}` :""}
                  </span>
                </span>
                <form action={claimJobAction}>
                  <input type="hidden" name="jobId" value={j.id} />
                  <button className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
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
          <p className="text-sm text-text-mute">—</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {inProgress.map((j) => {
              // Diagnosis-stage button gating: spec says only ONE button
              // visible at a time — never Open + Send-for-Estimate together.
              //  no REQUIRED parts → show Open only (prompts the tech to
              //   visit the detail page and add what's needed)
              //  ≥1 REQUIRED part → show Send-for-Estimate only (the tech
              //   has itemised what they found; ship it to the cashier)
              // The job-title link in the card already navigates to the
              // detail page, so hiding Open doesn't strand the tech.
              const isDiagnosing =
                j.status ==="ARRIVED"|| j.status ==="INSPECTION";
              const requiredCount =
                j.jobParts?.filter((p) => p.kind ==="REQUIRED").length ?? 0;
              const canSendForEstimate =
                !amHelper(j) && isDiagnosing && requiredCount > 0;
              // Open button shows for any in-progress non-helper job EXCEPT
              // when we're at the diagnosis stage AND the tech has already
              // added parts (in which case Send-for-Estimate replaces it).
              const showOpenButton = !(isDiagnosing && requiredCount > 0);
              // 'Mark complete' replaces it once the customer has approved
              // and work is happening (Stage 7). Helpers can also tap
              // (sometimes they finish the car while the primary's on lunch).
              const canMarkComplete =
                j.status ==="APPROVED"|| j.status ==="REPAIR";
              // 'Send for Approval' (extras loop) — only appears when the
              // tech has itemised extra work via the Extras panel on the
              // job detail page. No extras → no button.
              const extraCount =
                j.jobParts?.filter((p) => p.kind ==="EXTRA").length ?? 0;
              const canSendForReestimate =
                canMarkComplete && !amHelper(j) && extraCount > 0;
              return (
                <li
                  key={j.id}
                  className="flex flex-col gap-2 rounded-xl border border-border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/technician/jobs/${j.id}`}
                      className="text-lg font-medium hover:underline"
                    >
                      {priorityMeta(j.priority).badge} {carLine(j)}
                      {amHelper(j) ? (
                        <span className="ms-2 text-xs text-text-mute">
                          · {t("helpingTag")}
                        </span>
                      ) : null}
                    </Link>
                    {(() => {
                      const inv = j.invoices?.[0];
                      const paidTotal = inv ? inv.payments.reduce((s, p) => s + Number(p.amount), 0) : 0;
                      const invoicePaidInFull = inv ? paidTotal >= Number(inv.total) : false;
                      return (
                        <FriendlyStatusBadge
                          status={friendlyStatus({
                            status: j.status as JobStatus,
                            claimedById: j.claimedById,
                            latestEstimateStatus: (j.estimates?.[0]?.status ?? null) as
                              |"DRAFT"|"SENT"|"APPROVED"|"REJECTED"| null,
                            invoicePaidInFull,
                          })}
                          t={t}
                          size="sm"
                        />
                      );
                    })()}
                  </div>
                  <JobTimings
                    claimedAt={j.claimedAt}
                    sentForEstimateAt={j.sentForEstimateAt}
                    estimateSentAt={j.estimates?.[0]?.sentAt ?? null}
                    now={now}
                    t={t}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {showOpenButton ? (
                      <Link
                        href={`/technician/jobs/${j.id}`}
                        className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                      >
                        {t("open")}
                      </Link>
                    ) : null}
                    {canSendForEstimate ? (
                      <form action={sendForEstimateAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                          {t("sendForEstimate")}
                        </button>
                      </form>
                    ) : null}
                    {canSendForReestimate ? (
                      <form action={sendForReestimateAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-danger-600 text-white hover:bg-danger-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                          {t("extrasSendForApproval").replace(
                          "{count}",
                            String(extraCount),
                          )}
                        </button>
                      </form>
                    ) : null}
                    {/* 'Finish' / 'Mark Complete' button removed from the
                        dashboard per spec — APPROVED / REPAIR rows now
                        only show the Open button. The actual workflow-
                        completing action (markCompleteAction → status
                        TECH_COMPLETE) lives on the job detail page now,
                        so the tech opens the job, reviews the work, and
                        taps Mark Complete from inside. Dashboard stays
                        clean: every approved row has exactly one button. */}
                    {/* Release-claim button removed per workflow spec — the
                        tech who claims a job sees it through. To unclaim a
                        car they can release it via the job detail page. */}
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
                className="flex items-center justify-between rounded-xl border border-border p-4"
              >
                <span>
                  <span className="block font-medium">
                    {priorityMeta(j.priority).badge} {carLine(j)}
                  </span>
                  <span className="text-xs text-text-mute">
                    🔧 {techNames.get(j.claimedById ?? "") ??"—"}
                  </span>
                </span>
                <form action={joinJobAction}>
                  <input type="hidden" name="jobId" value={j.id} />
                  <button className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
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
                className="flex items-center justify-between rounded-xl border border-warning-500/40 bg-warning-50 p-4 dark:border-warning-500/30 dark:bg-warning-500/10"
              >
                <span>
                  <span className="block text-lg font-medium">{carLine(j)}</span>
                  <span className="text-xs text-warning-600 dark:text-warning-500">
                    🟡 {reasonLabel(j.holdReason)}
                  </span>
                </span>
                <Link
                  href={`/technician/jobs/${j.id}`}
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
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
