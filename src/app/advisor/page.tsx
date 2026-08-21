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
import { canSeeMargin } from "@/lib/permissions";
import { computeJobProfit } from "@/lib/job-profit";
import { compareReceiptToInvoice } from "@/lib/direct-fit-receipt";

export const dynamic ="force-dynamic";

export default async function AdvisorHome() {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const t = await getT();

  // Explicit select on JobCard to bypass the 'missing column in
  // live DB' risk that's been blocking the vehicle-history page.
  // Only the fields the page render actually reads are listed —
  // ANY column in the Prisma schema that isn't in the live DB no
  // longer takes this page down.
  //
  // Resilience: this is the ADVISOR + MASTER landing page (MASTER's
  // roleHome is also `/advisor`). A single Prisma glitch here — dev
  // proxy P1017 or the Supabase pooler dropping a socket in prod —
  // used to take the whole page down with "Something went wrong",
  // stranding both roles at their home. Owner's dashboard already
  // has this treatment; matching it here. Fallbacks show the empty
  // state + a non-blocking banner so the user knows data is stale.
  let jobs: Awaited<ReturnType<typeof prisma.jobCard.findMany<{
    select: {
      id: true;
      status: true;
      priority: true;
      claimedById: true;
      claimedAt: true;
      assignedToId: true;
      sentForEstimateAt: true;
      holdReason: true;
      vehicle: { select: { make: true; model: true; plate: true; customer: { select: { name: true } } } };
      estimates: {
        orderBy: { createdAt: "desc" };
        take: 1;
        select: { status: true; sentAt: true; createdAt: true };
      };
      invoices: {
        orderBy: { issuedAt: "desc" };
        take: 1;
        select: {
          total: true;
          payments: { select: { amount: true } };
        };
      };
    };
  }>>> = [];
  let pendingBookings = 0;
  let techs: { id: string; name: string }[] = [];
  let hadError = false;
  try {
    [jobs, pendingBookings, techs] = await Promise.all([
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
  } catch (e) {
    console.error("[advisor] jobs/bookings/techs fan-out failed — degrading:", e);
    hadError = true;
  }
  const techName = (uid: string | null) => techs.find((x) => x.id === uid)?.name;
  // Server-side 'now' for the in-progress duration captions (no client clock
  // — every row reads from the same wall time on render).
  const now = new Date();

  // Step 8 (AR 2026-08-22) — per-job margin chip on the list, with a
  // coverage badge when incomplete. Gated by canSeeMargin so only
  // advisor/owner/master see it; tech and cashier get no signal here.
  // Only computed for jobs that have an invoice — margin needs frozen
  // InvoiceLine.unitCost (per Step 5 spec §Cost model). Everything
  // pre-invoice would be a moving live-catalog estimate; the spec
  // explicitly excludes that.
  const canShowMargin = canSeeMargin(session.user.role);
  const marginByJobId = new Map<string, { pct: number | null; covered: number; total: number }>();
  if (canShowMargin && jobs.length > 0) {
    const jobIds = jobs.map((j) => j.id);
    try {
      // Batch-load invoice lines + sessions + receipts for every
      // active job. Bounded by jobs.length (active workload — small,
      // usually < 50). Each map is jobId-keyed for O(1) lookup below.
      const [invLines, sessions, receipts] = await Promise.all([
        prisma.invoice.findMany({
          where: { jobCardId: { in: jobIds } },
          orderBy: { createdAt: "desc" },
          select: {
            jobCardId: true,
            lines: { select: { kind: true, qty: true, lineTotal: true, unitCost: true } },
          },
        }),
        prisma.workSession.findMany({
          where: { jobCardId: { in: jobIds }, endedAt: { not: null } },
          select: {
            jobCardId: true,
            laborCostSnapshot: true,
            startedAt: true,
            endedAt: true,
          },
        }),
        prisma.jobPartReceipt.findMany({
          where: { jobCardId: { in: jobIds } },
          select: {
            jobCardId: true,
            qty: true,
            receivedUnitCost: true,
            purchaseOrderLine: {
              select: {
                sourceEstimateLine: {
                  select: {
                    unitCost: true,
                    estimate: { select: { invoice: { select: { id: true } } } },
                  },
                },
              },
            },
          },
        }),
      ]);
      // Keep only the MOST RECENT invoice per job (first entry in the
      // desc-ordered list). Older invoices are voided/superseded — we
      // want the live one, mirroring the per-job card's query.
      const linesByJob = new Map<string, typeof invLines[number]["lines"]>();
      for (const inv of invLines) {
        if (!linesByJob.has(inv.jobCardId)) linesByJob.set(inv.jobCardId, inv.lines);
      }
      const sessionsByJob = new Map<string, typeof sessions>();
      for (const s of sessions) {
        const arr = sessionsByJob.get(s.jobCardId) ?? [];
        arr.push(s);
        sessionsByJob.set(s.jobCardId, arr);
      }
      const receiptsByJob = new Map<string, typeof receipts>();
      for (const r of receipts) {
        const arr = receiptsByJob.get(r.jobCardId) ?? [];
        arr.push(r);
        receiptsByJob.set(r.jobCardId, arr);
      }
      for (const j of jobs) {
        const lines = linesByJob.get(j.id);
        if (!lines) continue; // no invoice yet — no margin to show
        const jSessions = (sessionsByJob.get(j.id) ?? []).map((s) => ({
          laborCostSnapshot: s.laborCostSnapshot,
          startedAt: s.startedAt ?? undefined,
          endedAt: s.endedAt ?? undefined,
        }));
        const jReceipts = (receiptsByJob.get(j.id) ?? []).map((r) => {
          const cmp = compareReceiptToInvoice({
            receivedUnitCost: Number(r.receivedUnitCost),
            qty: r.qty,
            sourceEstimateLine: r.purchaseOrderLine.sourceEstimateLine
              ? {
                  unitCost:
                    r.purchaseOrderLine.sourceEstimateLine.unitCost === null
                      ? null
                      : Number(r.purchaseOrderLine.sourceEstimateLine.unitCost),
                  estimateHasInvoice: Boolean(
                    r.purchaseOrderLine.sourceEstimateLine.estimate.invoice,
                  ),
                }
              : null,
          });
          return { status: cmp.status, totalDelta: cmp.totalDelta };
        });
        const p = computeJobProfit(lines, jSessions, jReceipts);
        // Coverage = parts covered + labour covered (out of totals).
        // Same shape as JobProfitCard reads. Zero-total sides count as
        // fully-covered (nothing to be missing).
        const covered = p.coverage.partsCovered + p.coverage.laborCovered;
        const total = p.coverage.partsTotal + p.coverage.laborTotal;
        marginByJobId.set(j.id, {
          pct: p.grossMarginPct === null ? null : Number(p.grossMarginPct),
          covered,
          total,
        });
      }
    } catch (e) {
      // Non-fatal — if the margin fan-out fails we simply omit the
      // chip. The primary job list stays functional.
      console.error("[advisor] margin fan-out failed — omitting chips:", e);
    }
  }
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

      {hadError ? (
        <div className="rounded-xl border border-warning-500/40 bg-warning-50 px-4 py-2.5 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
          ⚠️ Couldn&apos;t load the job list right now. Try again in a moment — the rest of the site still works.
        </div>
      ) : null}

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
                  {/* Step 8 (AR 2026-08-22) — margin chip w/ coverage.
                      "—" when margin is null (any Unknown side); the
                      coverage suffix "(2/3)" makes the reason visible
                      instead of a bare dash. Only rendered when the
                      job has an invoice (marginByJobId gets an entry
                      only for those). */}
                  {(() => {
                    const m = marginByJobId.get(job.id);
                    if (!m) return null;
                    const full = m.total > 0 && m.covered === m.total;
                    const chipCls =
                      m.pct === null
                        ? "border-border text-text-mute"
                        : m.pct >= 20
                          ? "border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-200"
                          : m.pct > 0
                            ? "border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-200"
                            : "border-rose-300 text-rose-800 dark:border-rose-800 dark:text-rose-200";
                    return (
                      <span
                        className={
                          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium tabular-nums " +
                          chipCls
                        }
                        title={
                          full
                            ? `Margin — all lines have cost data (${m.total} of ${m.total})`
                            : `Margin coverage: ${m.covered} of ${m.total} lines have cost data`
                        }
                      >
                        {t("marginChipLabel")} {m.pct === null ? "—" : `${Number(m.pct).toFixed(1)}%`}
                        {full ? null : (
                          <span className="opacity-70">
                            ({m.covered}/{m.total})
                          </span>
                        )}
                      </span>
                    );
                  })()}
                </span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </main>
  );
}
