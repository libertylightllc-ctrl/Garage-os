import { prisma } from "@/lib/prisma";
import { ACCOUNTS, arState } from "@/lib/billing";
import { scopeWhere } from "@/lib/branches";

// All metrics accept one garageId or several (the owner's company = root + branches).
type Scope = string | string[];

// Read-only, ALWAYS garage-scoped metric queries. The copilot may only call these
// (no raw SQL), which guarantees tenant isolation.

function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
function daysAgo(now: Date, n: number): Date {
  return new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
}

async function sumAccount(garageId: Scope, account: string, from?: Date, to?: Date): Promise<number> {
  const where: Record<string, unknown> = { garageId: scopeWhere(garageId), account };
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
  const agg = await prisma.ledgerEntry.aggregate({ where, _sum: { credit: true, debit: true } });
  return Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0);
}

/** Revenue (credit-normal Sales Revenue) over an optional date range. */
export async function revenue(garageId: Scope, from?: Date, to?: Date): Promise<number> {
  return Math.round(((await sumAccount(garageId, ACCOUNTS.SALES, from, to)) || 0) * 100) / 100;
}

/** Parts COGS over a range from negative PartMovements * part cost. */
async function partsCost(garageId: Scope, from?: Date): Promise<number> {
  const moves = await prisma.partMovement.findMany({
    where: { part: { garageId: scopeWhere(garageId) }, delta: { lt: 0 }, ...(from ? { createdAt: { gte: from } } : {}) },
    include: { part: { select: { cost: true } } },
  });
  return moves.reduce((s, m) => s + Math.abs(m.delta) * Number(m.part.cost), 0);
}

export async function profitThisMonth(garageId: Scope, now = new Date()): Promise<number> {
  const from = startOfMonth(now);
  const rev = await revenue(garageId, from);
  const cogs = await partsCost(garageId, from);
  return Math.round((rev - cogs) * 100) / 100;
}

export async function carsToday(garageId: Scope, now = new Date()): Promise<number> {
  return prisma.jobCard.count({ where: { garageId: scopeWhere(garageId), createdAt: { gte: startOfToday(now) } } });
}

export async function inventoryHealth(garageId: Scope): Promise<{ low: number; total: number }> {
  // Low-stock is PER-PART: qtyOnHand at or below that part's own
  // reorderLevel (Inventory 1a replaced the old hardcoded "5"). Prisma
  // can't compare two columns in a count(), and discontinued parts aren't
  // reordered, so tally the ACTIVE catalog's levels in memory. Catalogs
  // are small (dozens of rows per garage).
  const parts = await prisma.part.findMany({
    where: { garageId: scopeWhere(garageId), active: true },
    select: { qtyOnHand: true, reorderLevel: true },
  });
  const low = parts.filter((p) => p.qtyOnHand <= p.reorderLevel).length;
  return { low, total: parts.length };
}

/**
 * The reorder shortlist for the owner dashboard — the actual ACTIVE parts
 * at or below their reorder level, most-urgent first (biggest shortfall,
 * then lowest stock), capped at `limit`. Returns the items plus the full
 * low count so the UI can show "+N more". Read-only + garage-scoped like
 * every metric here.
 */
export async function lowStockParts(
  garageId: Scope,
  limit = 5,
): Promise<{
  items: { id: string; name: string; sku: string; qtyOnHand: number; reorderLevel: number }[];
  low: number;
}> {
  const parts = await prisma.part.findMany({
    where: { garageId: scopeWhere(garageId), active: true },
    select: { id: true, name: true, sku: true, qtyOnHand: true, reorderLevel: true },
  });
  const lowAll = parts
    .filter((p) => p.qtyOnHand <= p.reorderLevel)
    .sort(
      (a, b) =>
        a.qtyOnHand - a.reorderLevel - (b.qtyOnHand - b.reorderLevel) ||
        a.qtyOnHand - b.qtyOnHand,
    );
  return { items: lowAll.slice(0, limit), low: lowAll.length };
}

export async function weekTrend(
  garageId: Scope,
  now = new Date(),
): Promise<{ thisWeek: number; lastWeek: number; delta: number }> {
  const thisFrom = daysAgo(now, 7);
  const lastFrom = daysAgo(now, 14);
  const thisWeek = await revenue(garageId, thisFrom);
  const lastWeek = await revenue(garageId, lastFrom, thisFrom);
  return { thisWeek, lastWeek, delta: Math.round((thisWeek - lastWeek) * 100) / 100 };
}

export interface OwesRow {
  id: string;
  customer: string;
  balance: number;
  overdue: boolean;
}

// AI usage (the Layer-2 margin trap) — events + estimated cost over a range.
export async function aiUsage(
  garageId: Scope,
  from?: Date,
): Promise<{ events: number; costUsd: number }> {
  const where: Record<string, unknown> = { garageId: scopeWhere(garageId) };
  if (from) where.createdAt = { gte: from };
  const agg = await prisma.aiEvent.aggregate({ where, _sum: { costEstimate: true }, _count: true });
  return { events: agg._count, costUsd: Number(agg._sum.costEstimate ?? 0) };
}

// Pilot hypothesis: AI intake proposal accepted by advisor without rejection.
export async function intakeAcceptance(
  garageId: Scope,
): Promise<{ confirmed: number; rejected: number; rate: number | null }> {
  const [confirmed, rejected] = await Promise.all([
    prisma.booking.count({ where: { garageId: scopeWhere(garageId), status: "CONFIRMED" } }),
    prisma.booking.count({ where: { garageId: scopeWhere(garageId), status: "REJECTED" } }),
  ]);
  const decided = confirmed + rejected;
  return { confirmed, rejected, rate: decided ? confirmed / decided : null };
}

// Pilot hypothesis: time from customer booking to advisor confirmation (minutes).
export async function avgConfirmMinutes(garageId: Scope): Promise<number | null> {
  const bookings = await prisma.booking.findMany({
    where: { garageId: scopeWhere(garageId), status: "CONFIRMED", jobCard: { isNot: null } },
    include: { jobCard: { select: { createdAt: true } } },
  });
  const diffs = bookings
    .filter((b) => b.jobCard)
    .map((b) => (b.jobCard!.createdAt.getTime() - b.createdAt.getTime()) / 60000);
  if (diffs.length === 0) return null;
  return Math.round((diffs.reduce((a, c) => a + c, 0) / diffs.length) * 10) / 10;
}

export async function whoOwes(garageId: Scope, now = new Date()): Promise<OwesRow[]> {
  const invoices = await prisma.invoice.findMany({
    where: { garageId: scopeWhere(garageId), status: { not: "PAID" } },
    include: { payments: true, jobCard: { include: { vehicle: { include: { customer: true } } } } },
  });
  return invoices
    .map((inv) => {
      const total = Number(inv.total);
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
      const balance = Math.round((total - paid) * 100) / 100;
      return {
        id: inv.id,
        customer: inv.jobCard.vehicle.customer.name,
        balance,
        overdue: arState(total, paid, inv.dueDate, now) === "OVERDUE",
      };
    })
    .filter((r) => r.balance > 0);
}

// ── Slice #4 — advisor activity ──────────────────────────────────
// Mirror shape of TechWork: per-staff rollup the owner reads at a
// glance on /owner. Advisor metrics differ from tech ones because the
// advisor's job revolves around the customer-facing estimate cycle,
// not the spanner. We count:
//   jobsCreated     — JobCard rows where this advisor is the
//                     advisorId (intake handoff).
//   estimatesSent   — Estimate rows with sentAt set whose JobCard has
//                     this advisorId. SENT is the advisor's surface
//                     in slice 2's preview-then-send flow.
//   approvedCount   — those estimates the customer approved.
//   rejectedCount   — those the customer turned down.
//   approvalRate    — approved / (approved + rejected). null when no
//                     decisions yet (don't show '0%' on a fresh advisor).
//   avgApprovalMin  — mean (approvedAt − sentAt) for approved-after-sent
//                     estimates. Tells the owner how long the
//                     customer typically sits on a quote before
//                     deciding. null when no approvals yet.
export interface AdvisorActivity {
  advisorId: string;
  name: string;
  jobsCreated: number;
  estimatesSent: number;
  approvedCount: number;
  rejectedCount: number;
  approvalRate: number | null;
  avgApprovalMin: number | null;
}

export async function advisorActivity(garageId: Scope): Promise<AdvisorActivity[]> {
  const [jobs, estimates] = await Promise.all([
    prisma.jobCard.findMany({
      where: { garageId: scopeWhere(garageId), advisorId: { not: null } },
      select: { advisorId: true, advisor: { select: { name: true } } },
    }),
    // All estimates the advisor sent. Filtered to sentAt non-null so a
    // DRAFT the cashier is still pricing doesn't inflate the 'sent'
    // count. status drives approved/rejected; approvedAt drives the
    // duration math.
    prisma.estimate.findMany({
      where: {
        jobCard: { garageId: scopeWhere(garageId), advisorId: { not: null } },
        sentAt: { not: null },
      },
      select: {
        status: true,
        sentAt: true,
        approvedAt: true,
        jobCard: {
          select: {
            advisorId: true,
            advisor: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  const map = new Map<
    string,
    AdvisorActivity & { sumApprovalMin: number; approvalCount: number }
  >();
  const ensure = (id: string, name: string) => {
    if (!map.has(id)) {
      map.set(id, {
        advisorId: id,
        name,
        jobsCreated: 0,
        estimatesSent: 0,
        approvedCount: 0,
        rejectedCount: 0,
        approvalRate: null,
        avgApprovalMin: null,
        sumApprovalMin: 0,
        approvalCount: 0,
      });
    }
    return map.get(id)!;
  };

  for (const j of jobs) {
    const e = ensure(j.advisorId as string, j.advisor?.name ?? "Advisor");
    e.jobsCreated++;
  }
  for (const est of estimates) {
    const advisorId = est.jobCard.advisorId as string;
    const e = ensure(advisorId, est.jobCard.advisor?.name ?? "Advisor");
    e.estimatesSent++;
    if (est.status === "APPROVED") {
      e.approvedCount++;
      if (est.sentAt && est.approvedAt) {
        // Clamp negative durations to 0 (defensive — clock skew).
        const min = Math.max(
          0,
          (est.approvedAt.getTime() - est.sentAt.getTime()) / 60000,
        );
        e.sumApprovalMin += min;
        e.approvalCount++;
      }
    } else if (est.status === "REJECTED") {
      e.rejectedCount++;
    }
  }

  return [...map.values()]
    .map(({ sumApprovalMin, approvalCount, ...rest }) => {
      const decisions = rest.approvedCount + rest.rejectedCount;
      return {
        ...rest,
        approvalRate:
          decisions > 0
            ? Math.round((rest.approvedCount / decisions) * 100)
            : null,
        avgApprovalMin:
          approvalCount > 0
            ? Math.round(sumApprovalMin / approvalCount)
            : null,
      };
    })
    .sort((a, b) => b.estimatesSent - a.estimatesSent);
}

export interface TechWork {
  techId: string;
  name: string;
  steps: number;
  jobs: number;
  photos: number;
  voice: number;
  parts: number;
  finishes: number;
  // Slice #3 — productivity time tracking. Derived from JobCard
  // claimedAt + workCompletedAt timestamps that already exist on the
  // model. avg is null when no completed jobs (don't display 0min).
  avgTimePerJobMin: number | null;
  totalTimeTodayMin: number;
  jobsToday: number;
}

// How much each technician worked individually (job steps logged,
// jobs touched, time on the spanner). Time math reads JobCard
// claimedAt → workCompletedAt; only completed jobs (both stamps set)
// contribute. 'Today' is UTC calendar day on workCompletedAt; matches
// the 'jobs completed today' reading on the owner dashboard.
export async function technicianWork(garageId: Scope): Promise<TechWork[]> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const [steps, completedJobs] = await Promise.all([
    prisma.jobStep.findMany({
      where: { jobCard: { garageId: scopeWhere(garageId) }, techId: { not: null } },
      select: { techId: true, type: true, jobCardId: true, tech: { select: { name: true } } },
    }),
    // Jobs the tech was the claimer on AND that have both timestamps —
    // these are the jobs we can confidently measure duration for. The
    // claimedById column has no Prisma relation back to User on the
    // JobCard model, so we resolve the name from the steps query's
    // tech relation later (every tech that completes a job will have
    // FINISH or other JobStep rows under their name).
    prisma.jobCard.findMany({
      where: {
        garageId: scopeWhere(garageId),
        claimedById: { not: null },
        claimedAt: { not: null },
        workCompletedAt: { not: null },
      },
      select: {
        claimedById: true,
        claimedAt: true,
        workCompletedAt: true,
      },
    }),
  ]);
  const map = new Map<
    string,
    TechWork & {
      jobSet: Set<string>;
      // Running totals for the time-math; finalised after the loops.
      sumDurMin: number;
      sumCount: number;
      todayDurMin: number;
      todayCount: number;
    }
  >();
  const ensure = (id: string, name: string) => {
    if (!map.has(id)) {
      map.set(id, {
        techId: id,
        name,
        steps: 0,
        jobs: 0,
        photos: 0,
        voice: 0,
        parts: 0,
        finishes: 0,
        avgTimePerJobMin: null,
        totalTimeTodayMin: 0,
        jobsToday: 0,
        jobSet: new Set<string>(),
        sumDurMin: 0,
        sumCount: 0,
        todayDurMin: 0,
        todayCount: 0,
      });
    }
    return map.get(id)!;
  };
  for (const s of steps) {
    const e = ensure(s.techId as string, s.tech?.name ?? "Technician");
    e.steps++;
    e.jobSet.add(s.jobCardId);
    if (s.type === "PHOTO") e.photos++;
    else if (s.type === "VOICE") e.voice++;
    else if (s.type === "PART_REQUEST") e.parts++;
    else if (s.type === "FINISH") e.finishes++;
  }
  for (const j of completedJobs) {
    // Guard: bad-data clock skew (workCompletedAt < claimedAt) would
    // produce a negative duration; clamp to 0 rather than skew the avg.
    const start = j.claimedAt!.getTime();
    const end = j.workCompletedAt!.getTime();
    const durMin = Math.max(0, (end - start) / 60000);
    // Name resolution: prefer whatever the steps loop already mapped
    // for this techId; fall back to a placeholder. A tech who has
    // completed jobs but ZERO JobSteps is theoretically possible (no
    // photos/voice/parts logged) — extreme edge case, won't happen in
    // practice but won't crash if it does.
    const existing = map.get(j.claimedById as string);
    const e = ensure(j.claimedById as string, existing?.name ?? "Technician");
    e.sumDurMin += durMin;
    e.sumCount += 1;
    if (j.workCompletedAt! >= todayStart) {
      e.todayDurMin += durMin;
      e.todayCount += 1;
    }
  }
  return [...map.values()]
    .map(({ jobSet, sumDurMin, sumCount, todayDurMin, todayCount, ...rest }) => ({
      ...rest,
      jobs: jobSet.size,
      avgTimePerJobMin: sumCount > 0 ? Math.round(sumDurMin / sumCount) : null,
      totalTimeTodayMin: Math.round(todayDurMin),
      jobsToday: todayCount,
    }))
    .sort((a, b) => b.steps - a.steps);
}
