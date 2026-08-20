import { prisma } from "@/lib/prisma";
import { computeLaborCostSnapshot } from "@/lib/worksession-cost-snapshot";

/**
 * Tech-tracking slice 1 — open/close/switch logic for WorkSession rows,
 * ALL in one place.
 *
 * Model: one row per continuous stretch of a tech working one car.
 * endedAt null = live segment. The DB enforces at most ONE open segment
 * per tech (partial unique index WorkSession_one_open_per_tech), so even
 * racing taps can't leave two timers running.
 *
 * CRITICAL CONTRACT: every export here is BEST-EFFORT. These are called
 * as side effects from the live claim / send / complete flows the shops
 * use daily — a session-write failure logs to stderr and returns; it
 * must NEVER throw into (and therefore never block) the job flow.
 *
 * AR 2026-08-12 profit reporting Step 4: every close path also freezes
 * `laborCostSnapshot` — hours × Garage.defaultLaborHourlyCost — so a
 * later rate change never rewrites historical margins. Null when the
 * garage has no rate set at close time; the profit card handles null
 * as the Unknown coverage bucket.
 */

// AUTO_CLOSED added AR 2026-08-20 (Finding 2). Written by the nightly
// cron /api/cron/auto-close-stale-sessions for any session still open
// >12h. Distinct from JOB_CLOSED because it carries no cost signal —
// we don't know when the tech actually stopped, so laborCostSnapshot
// stays null and the profit card handles the row as Unknown rather
// than crediting the full elapsed duration as work.
export type EndReason =
  | "SWITCHED"
  | "SENT_FOR_ESTIMATE"
  | "COMPLETED"
  | "JOB_CLOSED"
  | "AUTO_CLOSED";

/**
 * The tech is on THIS car now. Closes their previous open segment (any
 * car) and opens one on jobCardId — atomically, in one transaction.
 * Tapping the car they're already on is a no-op (no close/reopen churn).
 */
export async function startWorkSession(
  garageId: string,
  jobCardId: string,
  techId: string,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const open = await tx.workSession.findFirst({
        where: { techId, endedAt: null },
        select: { id: true, jobCardId: true, startedAt: true, garageId: true },
      });
      if (open?.jobCardId === jobCardId) return; // already on this car
      if (open) {
        const now = new Date();
        const rate = await garageLaborRate(tx, open.garageId);
        await tx.workSession.update({
          where: { id: open.id },
          data: {
            endedAt: now,
            endReason: "SWITCHED",
            laborCostSnapshot: computeLaborCostSnapshot(open.startedAt, now, rate),
          },
        });
      }
      await tx.workSession.create({
        data: { garageId, jobCardId, techId },
      });
    });
  } catch (e) {
    console.error("[work-session] startWorkSession failed (job flow unaffected):", e);
  }
}

/** Close the tech's open segment, whatever car it's on. */
export async function closeTechSession(techId: string, reason: EndReason): Promise<void> {
  try {
    await closeMatchingSessions({ techId, endedAt: null }, reason);
  } catch (e) {
    console.error("[work-session] closeTechSession failed (job flow unaffected):", e);
  }
}

/**
 * Close every open segment on a JOB (all techs — claimer and helpers).
 * Used when the car leaves active work: sent for estimate, completed,
 * put on hold, cancelled.
 */
export async function closeJobSessions(jobCardId: string, reason: EndReason): Promise<void> {
  try {
    await closeMatchingSessions({ jobCardId, endedAt: null }, reason);
  } catch (e) {
    console.error("[work-session] closeJobSessions failed (job flow unaffected):", e);
  }
}

/** A tech's live segment (null if idle). READ — used by UI, may throw. */
export function openSessionFor(techId: string) {
  return prisma.workSession.findFirst({
    where: { techId, endedAt: null },
    select: { id: true, jobCardId: true, startedAt: true },
  });
}

/**
 * The live floor: every open segment in the garage(s), plus which techs
 * are idle. Takes an array so the owner's aggregated-branches view works
 * (pass companyGarageIds); single-branch callers pass [garageId].
 * READ — used by the live board, may throw.
 */
export async function floorNow(garageIds: string[]) {
  const [open, techs] = await Promise.all([
    prisma.workSession.findMany({
      where: { garageId: { in: garageIds }, endedAt: null },
      select: {
        startedAt: true,
        tech: { select: { id: true, name: true } },
        jobCard: {
          select: {
            id: true,
            number: true,
            bay: { select: { name: true } },
            vehicle: { select: { make: true, model: true, plate: true } },
          },
        },
      },
      orderBy: { startedAt: "asc" },
    }),
    prisma.user.findMany({
      where: { garageId: { in: garageIds }, role: { in: ["TECH", "MASTER"] } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const busy = new Set(open.map((s) => s.tech.id));
  return { working: open, idle: techs.filter((t) => !busy.has(t.id)) };
}

/**
 * Auto-close every session still open older than `olderThanMs` ago
 * (AR 2026-08-20 Finding 2, nightly cron path). Distinct from
 * closeJobSessions / closeTechSession because:
 *
 *   1. endReason = "AUTO_CLOSED" — the profit card treats this as
 *      Unknown (via null laborCostSnapshot below), and an audit
 *      query can distinguish "operator forgot to stop the clock"
 *      from every other close cause.
 *   2. laborCostSnapshot = NULL, always. We don't know when the
 *      tech actually stopped — recording (elapsedTime × rate) as
 *      "labour cost" would invent a number. Null routes the
 *      session into the profit card's Unknown bucket, honest
 *      about the missing signal.
 *   3. endedAt stamped at now(), not at some fictional "when they
 *      probably left". The elapsed duration is preserved as raw
 *      data (startedAt is untouched, endedAt = now), but no cost
 *      is derived from it.
 *
 * Returns per-session summary so the cron can log a pattern check
 * ("tech X had N auto-closes in past week") without an extra query.
 */
export async function autoCloseStaleSessions(olderThanMs: number): Promise<Array<{
  id: string;
  techId: string;
  techName: string | null;
  jobCardId: string;
  jobCardNumber: number | null;
  startedAt: Date;
  durationHours: number;
}>> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - olderThanMs);
  const stale = await prisma.workSession.findMany({
    where: { endedAt: null, startedAt: { lt: cutoff } },
    select: {
      id: true,
      startedAt: true,
      tech: { select: { id: true, name: true } },
      jobCard: { select: { id: true, number: true } },
    },
  });
  if (stale.length === 0) return [];
  await prisma.$transaction(
    stale.map((s) =>
      prisma.workSession.update({
        where: { id: s.id },
        data: {
          endedAt: now,
          endReason: "AUTO_CLOSED",
          // Deliberately null — see docstring rationale.
          laborCostSnapshot: null,
        },
      }),
    ),
  );
  return stale.map((s) => ({
    id: s.id,
    techId: s.tech.id,
    techName: s.tech.name,
    jobCardId: s.jobCard.id,
    jobCardNumber: s.jobCard.number,
    startedAt: s.startedAt,
    durationHours: Math.round(((now.getTime() - s.startedAt.getTime()) / 3_600_000) * 10) / 10,
  }));
}

// ── internals ─────────────────────────────────────────────────────

// The pre-Step-4 code used updateMany() to close matching rows in one
// query. That was fine when there was nothing per-row to compute, but
// laborCostSnapshot needs the row's OWN startedAt to derive hours, and
// updateMany can't do per-row math. We fetch, group by garage to fetch
// the rate once per garage (in practice always 1 since jobs and techs
// belong to a single garage), then write.
//
// Any per-row failure is swallowed by the caller's try/catch. The close
// still happens for every row that succeeds; a partial write beats
// blocking the job flow.
async function closeMatchingSessions(
  where: { techId?: string; jobCardId?: string; endedAt: null },
  reason: EndReason,
): Promise<void> {
  const now = new Date();
  const open = await prisma.workSession.findMany({
    where,
    select: { id: true, startedAt: true, garageId: true },
  });
  if (open.length === 0) return;

  // Rate per garage — fetched once for the (usually single) garage the
  // matched rows span. Falls to null if the garage row is somehow gone.
  const rateByGarage = new Map<string, Awaited<ReturnType<typeof garageLaborRate>>>();
  const uniqueGarageIds = Array.from(new Set(open.map((s) => s.garageId)));
  for (const gid of uniqueGarageIds) {
    rateByGarage.set(gid, await garageLaborRate(prisma, gid));
  }

  await prisma.$transaction(
    open.map((s) =>
      prisma.workSession.update({
        where: { id: s.id },
        data: {
          endedAt: now,
          endReason: reason,
          laborCostSnapshot: computeLaborCostSnapshot(
            s.startedAt,
            now,
            rateByGarage.get(s.garageId) ?? null,
          ),
        },
      }),
    ),
  );
}

// The garage's current labour hourly cost, or null when not set. Reads
// the same client the caller is using (prisma or a $transaction tx)
// so an in-flight snapshot never straddles the rate boundary.
async function garageLaborRate(
  client: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  garageId: string,
): Promise<import("@/generated/prisma/client").Prisma.Decimal | null> {
  const row = await client.garage.findUnique({
    where: { id: garageId },
    select: { defaultLaborHourlyCost: true },
  });
  return row?.defaultLaborHourlyCost ?? null;
}
