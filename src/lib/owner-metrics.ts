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
  const [low, total] = await Promise.all([
    prisma.part.count({ where: { garageId: scopeWhere(garageId), qtyOnHand: { lte: 5 } } }),
    prisma.part.count({ where: { garageId: scopeWhere(garageId) } }),
  ]);
  return { low, total };
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

export interface TechWork {
  techId: string;
  name: string;
  steps: number;
  jobs: number;
  photos: number;
  voice: number;
  parts: number;
  finishes: number;
}

// How much each technician worked individually (job steps logged, jobs touched).
export async function technicianWork(garageId: Scope): Promise<TechWork[]> {
  const steps = await prisma.jobStep.findMany({
    where: { jobCard: { garageId: scopeWhere(garageId) }, techId: { not: null } },
    select: { techId: true, type: true, jobCardId: true, tech: { select: { name: true } } },
  });
  const map = new Map<string, TechWork & { jobSet: Set<string> }>();
  for (const s of steps) {
    const k = s.techId as string;
    if (!map.has(k)) {
      map.set(k, {
        techId: k,
        name: s.tech?.name ?? "Technician",
        steps: 0,
        jobs: 0,
        photos: 0,
        voice: 0,
        parts: 0,
        finishes: 0,
        jobSet: new Set<string>(),
      });
    }
    const e = map.get(k)!;
    e.steps++;
    e.jobSet.add(s.jobCardId);
    if (s.type === "PHOTO") e.photos++;
    else if (s.type === "VOICE") e.voice++;
    else if (s.type === "PART_REQUEST") e.parts++;
    else if (s.type === "FINISH") e.finishes++;
  }
  return [...map.values()]
    .map(({ jobSet, ...rest }) => ({ ...rest, jobs: jobSet.size }))
    .sort((a, b) => b.steps - a.steps);
}
