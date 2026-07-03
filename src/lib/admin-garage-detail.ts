import { prisma } from "@/lib/prisma";
import * as metrics from "@/lib/owner-metrics";
import type { AdminContext } from "@/lib/admin-auth";

// Phase 3 admin data-access layer. Every function takes an AdminContext
// as its FIRST parameter, by signature. The context can only come from
// requireAdmin() — there's no other way to construct one — so any call
// to a function in this file proves the caller is past the admin gate.
//
// Tenant safety:
//   - Functions read across garages by garageId argument. They DO NOT
//     touch session() or any session-scoped helper. The page wrapper
//     in src/app/admin/garages/[id]/page.tsx is responsible for passing
//     the right garageId; this file just reads it.
//   - Owner metrics functions (src/lib/owner-metrics.ts) already accept
//     a garageId/array and are pure prisma reads. We reuse them rather
//     than duplicate query logic — that keeps prod-owner numbers and
//     admin-view numbers in lock-step. If you change owner-metrics, you
//     change both.
//
// We touch `admin` to satisfy lint and to make the contract explicit at
// every call site; the runtime check has already happened.

const STALE_DAYS = 14;

export interface GarageOverview {
  id: string;
  name: string;
  country: string;
  trn: string | null;
  isPilot: boolean;
  createdAt: Date;
  ownerEmail: string | null;
  ownerName: string | null;
}

export async function getGarageOverview(
  admin: AdminContext,
  garageId: string
): Promise<GarageOverview | null> {
  void admin;
  const g = await prisma.garage.findUnique({
    where: { id: garageId },
    include: {
      users: {
        where: { role: "OWNER" },
        select: { email: true, name: true },
        take: 1,
      },
    },
  });
  if (!g) return null;
  return {
    id: g.id,
    name: g.name,
    country: g.country,
    trn: g.trn,
    isPilot: g.isPilot,
    createdAt: g.createdAt,
    ownerEmail: g.users[0]?.email ?? null,
    ownerName: g.users[0]?.name ?? null,
  };
}

export interface GarageDataUsage {
  rowCounts: { table: string; n: number }[];
  totalRows: number;
  /** Photos + voice notes attached to this garage's jobs. */
  uploadedFiles: { photos: number; voiceNotes: number; logo: boolean };
}

export async function getGarageDataUsage(
  admin: AdminContext,
  garageId: string
): Promise<GarageDataUsage> {
  void admin;
  // Sequence (not Promise.all): the Prisma pg adapter's unnamed
  // prepared-statement cache races on concurrent queries against the
  // Prisma 7 bundled dev DB ("bind message supplies N parameters, but
  // prepared statement '' requires 0"). Admin views are low-traffic;
  // ~50ms slower beats fighting the adapter.
  const customers = await prisma.customer.count({ where: { garageId } });
  const vehicles = await prisma.vehicle.count({ where: { customer: { garageId } } });
  const jobCards = await prisma.jobCard.count({ where: { garageId } });
  const estimates = await prisma.estimate.count({ where: { jobCard: { garageId } } });
  const invoices = await prisma.invoice.count({ where: { garageId } });
  const ledger = await prisma.ledgerEntry.count({ where: { garageId } });
  const ai = await prisma.aiEvent.count({ where: { garageId } });
  const waMessages = await prisma.whatsAppMessage.count({ where: { thread: { garageId } } });
  const parts = await prisma.part.count({ where: { garageId } });
  const partRequests = await prisma.partRequest.count({ where: { garageId } });
  const bookings = await prisma.booking.count({ where: { garageId } });
  const reminders = await prisma.reminder.count({ where: { garageId } });
  const users = await prisma.user.count({ where: { garageId } });

  const rowCounts = [
    { table: "Customer", n: customers },
    { table: "Vehicle", n: vehicles },
    { table: "JobCard", n: jobCards },
    { table: "Estimate", n: estimates },
    { table: "Invoice", n: invoices },
    { table: "LedgerEntry", n: ledger },
    { table: "AiEvent", n: ai },
    { table: "WhatsAppMessage", n: waMessages },
    { table: "Part", n: parts },
    { table: "PartRequest", n: partRequests },
    { table: "Booking", n: bookings },
    { table: "Reminder", n: reminders },
    { table: "User", n: users },
  ];
  const totalRows = rowCounts.reduce((s, r) => s + r.n, 0);

  // Storage usage: count file references attached to this garage's
  // jobs. We don't compute bytes — that'd require a Supabase Storage
  // API round-trip per file. Counts are enough for a "is this garage
  // a heavy uploader" signal; byte size can come in Phase 3.1 if you
  // need it for billing.
  const photoSteps = await prisma.jobStep.count({
    where: { jobCard: { garageId }, photoUrl: { not: null } },
  });
  const voiceNoteSteps = await prisma.jobStep.count({
    where: { jobCard: { garageId }, voiceNoteUrl: { not: null } },
  });
  const garageRow = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { logoUrl: true },
  });

  return {
    rowCounts,
    totalRows,
    uploadedFiles: {
      photos: photoSteps,
      voiceNotes: voiceNoteSteps,
      logo: !!garageRow?.logoUrl,
    },
  };
}

export interface GarageActivity {
  /** Most recent activity across job cards, invoices, ledger,
   *  WhatsApp messages. null if the garage has no records. */
  lastActiveAt: Date | null;
  /** Days since lastActiveAt. null mirrors lastActiveAt null. */
  daysIdle: number | null;
  /** True when daysIdle exceeds the staleness threshold. */
  isQuiet: boolean;
  users: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    lastLoginAt: Date | null;
    createdAt: Date;
  }>;
}

export async function getGarageActivity(
  admin: AdminContext,
  garageId: string
): Promise<GarageActivity> {
  void admin;

  // "When did this garage last DO anything." Pick the most recent
  // timestamp across the activity-bearing tables. Whichever is newest
  // wins; null means literally nothing was ever created.
  // Sequenced for the same Prisma-adapter race reason as DataUsage above.
  const latestJob = await prisma.jobCard.findFirst({
    where: { garageId },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  const latestInvoice = await prisma.invoice.findFirst({
    where: { garageId },
    orderBy: { issuedAt: "desc" },
    select: { issuedAt: true },
  });
  const latestLedger = await prisma.ledgerEntry.findFirst({
    where: { garageId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const latestWa = await prisma.whatsAppMessage.findFirst({
    where: { thread: { garageId } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const users = await prisma.user.findMany({
    where: { garageId },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  const candidates: Date[] = [
    latestJob?.updatedAt,
    latestInvoice?.issuedAt,
    latestLedger?.createdAt,
    latestWa?.createdAt,
  ].filter((d): d is Date => d instanceof Date);

  const lastActiveAt =
    candidates.length === 0
      ? null
      : candidates.reduce((a, b) => (a > b ? a : b));
  const daysIdle =
    lastActiveAt === null
      ? null
      : Math.floor((Date.now() - lastActiveAt.getTime()) / 86_400_000);
  const isQuiet = daysIdle !== null && daysIdle > STALE_DAYS;

  return { lastActiveAt, daysIdle, isQuiet, users };
}

export interface GarageBusinessMetrics {
  revenueMonth: number;
  profitMonth: number;
  carsToday: number;
  weekTrend: { thisWeek: number; lastWeek: number; delta: number };
  aiUsage: { events: number; costUsd: number };
  intakeAcceptance: { confirmed: number; rejected: number; rate: number | null };
  avgConfirmMinutes: number | null;
  inventoryHealth: { low: number; total: number };
}

export async function getGarageBusinessMetrics(
  admin: AdminContext,
  garageId: string
): Promise<GarageBusinessMetrics> {
  void admin;
  const now = new Date();
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1);

  // Sequenced + per-call try/catch — keeps the page rendering even if
  // one metric blows up (same defence as the owner dashboard outage
  // fix). Slightly slower than Promise.allSettled, but avoids the
  // pg-adapter race.
  async function safe<T>(p: Promise<T>, fb: T): Promise<T> {
    try {
      return await p;
    } catch (e) {
      console.error("[admin-garage-metrics] subquery failed:", e);
      return fb;
    }
  }

  const revenueMonth = await safe(metrics.revenue(garageId, monthFrom), 0);
  const profitMonth = await safe(metrics.profitThisMonth(garageId, now), 0);
  const carsToday = await safe(metrics.carsToday(garageId, now), 0);
  const weekTrend = await safe(metrics.weekTrend(garageId, now), {
    thisWeek: 0,
    lastWeek: 0,
    delta: 0,
  });
  const aiUsage = await safe(metrics.aiUsage(garageId, monthFrom), {
    events: 0,
    costUsd: 0,
  });
  const intakeAcceptance = await safe(metrics.intakeAcceptance(garageId), {
    confirmed: 0,
    rejected: 0,
    rate: null as number | null,
  });
  const avgConfirmMinutes = await safe<number | null>(
    metrics.avgConfirmMinutes(garageId),
    null
  );
  const inventoryHealth = await safe(metrics.inventoryHealth(garageId), {
    low: 0,
    total: 0,
  });

  return {
    revenueMonth,
    profitMonth,
    carsToday,
    weekTrend,
    aiUsage,
    intakeAcceptance,
    avgConfirmMinutes,
    inventoryHealth,
  };
}
