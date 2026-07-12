import { prisma } from "@/lib/prisma";

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
 */

export type EndReason = "SWITCHED" | "SENT_FOR_ESTIMATE" | "COMPLETED" | "JOB_CLOSED";

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
        select: { id: true, jobCardId: true },
      });
      if (open?.jobCardId === jobCardId) return; // already on this car
      if (open) {
        await tx.workSession.update({
          where: { id: open.id },
          data: { endedAt: new Date(), endReason: "SWITCHED" },
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
    await prisma.workSession.updateMany({
      where: { techId, endedAt: null },
      data: { endedAt: new Date(), endReason: reason },
    });
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
    await prisma.workSession.updateMany({
      where: { jobCardId, endedAt: null },
      data: { endedAt: new Date(), endReason: reason },
    });
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
