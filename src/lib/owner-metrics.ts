import { prisma } from "@/lib/prisma";
import { ACCOUNTS, arState } from "@/lib/billing";

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

async function sumAccount(garageId: string, account: string, from?: Date, to?: Date): Promise<number> {
  const where: Record<string, unknown> = { garageId, account };
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
  const agg = await prisma.ledgerEntry.aggregate({ where, _sum: { credit: true, debit: true } });
  return Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0);
}

/** Revenue (credit-normal Sales Revenue) over an optional date range. */
export async function revenue(garageId: string, from?: Date, to?: Date): Promise<number> {
  return Math.round(((await sumAccount(garageId, ACCOUNTS.SALES, from, to)) || 0) * 100) / 100;
}

/** Parts COGS over a range from negative PartMovements * part cost. */
async function partsCost(garageId: string, from?: Date): Promise<number> {
  const moves = await prisma.partMovement.findMany({
    where: { part: { garageId }, delta: { lt: 0 }, ...(from ? { createdAt: { gte: from } } : {}) },
    include: { part: { select: { cost: true } } },
  });
  return moves.reduce((s, m) => s + Math.abs(m.delta) * Number(m.part.cost), 0);
}

export async function profitThisMonth(garageId: string, now = new Date()): Promise<number> {
  const from = startOfMonth(now);
  const rev = await revenue(garageId, from);
  const cogs = await partsCost(garageId, from);
  return Math.round((rev - cogs) * 100) / 100;
}

export async function carsToday(garageId: string, now = new Date()): Promise<number> {
  return prisma.jobCard.count({ where: { garageId, createdAt: { gte: startOfToday(now) } } });
}

export async function inventoryHealth(garageId: string): Promise<{ low: number; total: number }> {
  const [low, total] = await Promise.all([
    prisma.part.count({ where: { garageId, qtyOnHand: { lte: 5 } } }),
    prisma.part.count({ where: { garageId } }),
  ]);
  return { low, total };
}

export async function weekTrend(
  garageId: string,
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

export async function whoOwes(garageId: string, now = new Date()): Promise<OwesRow[]> {
  const invoices = await prisma.invoice.findMany({
    where: { garageId, status: { not: "PAID" } },
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
