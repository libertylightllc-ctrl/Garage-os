import { prisma } from "@/lib/prisma";

export const STALE_SESSION_MIN = 180; // 3 hours — flag, never discard

type SessionRow = {
  id: string;
  techId: string;
  techName: string;
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
};

export type TechTime = {
  techId: string;
  techName: string;
  totalMin: number;
  sessions: number;
};

export type JobTimeSummary = {
  totalMin: number;
  sessionCount: number;
  byTech: TechTime[];
  stale: boolean;
};

export type TechWrenchRow = {
  techId: string;
  techName: string;
  totalMin: number;
  carsTouched: number;
  avgPerCarMin: number;
  staleSessions: number;
};

function sessionMinutes(s: { startedAt: Date; endedAt: Date | null }, now: Date): number {
  const end = s.endedAt ?? now;
  return Math.max(0, (end.getTime() - s.startedAt.getTime()) / 60_000);
}

export function computeJobTimeSummary(
  sessions: SessionRow[],
  now: Date = new Date(),
): JobTimeSummary {
  if (sessions.length === 0) {
    return { totalMin: 0, sessionCount: 0, byTech: [], stale: false };
  }

  const byTech = new Map<string, { name: string; totalMin: number; sessions: number }>();
  let totalMin = 0;
  let stale = false;

  for (const s of sessions) {
    const mins = sessionMinutes(s, now);
    totalMin += mins;
    if (mins >= STALE_SESSION_MIN) stale = true;

    const existing = byTech.get(s.techId);
    if (existing) {
      existing.totalMin += mins;
      existing.sessions += 1;
    } else {
      byTech.set(s.techId, { name: s.techName, totalMin: mins, sessions: 1 });
    }
  }

  return {
    totalMin,
    sessionCount: sessions.length,
    byTech: Array.from(byTech.entries()).map(([techId, v]) => ({
      techId,
      techName: v.name,
      totalMin: v.totalMin,
      sessions: v.sessions,
    })),
    stale,
  };
}

export async function jobTimeSummary(jobCardId: string): Promise<JobTimeSummary> {
  const rows = await prisma.workSession.findMany({
    where: { jobCardId },
    select: {
      id: true,
      techId: true,
      tech: { select: { name: true } },
      startedAt: true,
      endedAt: true,
      endReason: true,
    },
    orderBy: { startedAt: "asc" },
  });

  const sessions: SessionRow[] = rows.map((r) => ({
    id: r.id,
    techId: r.techId,
    techName: r.tech.name,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    endReason: r.endReason,
  }));

  return computeJobTimeSummary(sessions);
}

export function computeTechWrenchTime(
  sessions: { techId: string; techName: string; jobCardId: string; startedAt: Date; endedAt: Date | null }[],
  now: Date = new Date(),
): TechWrenchRow[] {
  const byTech = new Map<
    string,
    { name: string; totalMin: number; cars: Set<string>; staleSessions: number }
  >();

  for (const s of sessions) {
    const mins = sessionMinutes(s, now);
    const existing = byTech.get(s.techId);
    if (existing) {
      existing.totalMin += mins;
      existing.cars.add(s.jobCardId);
      if (mins >= STALE_SESSION_MIN) existing.staleSessions += 1;
    } else {
      byTech.set(s.techId, {
        name: s.techName,
        totalMin: mins,
        cars: new Set([s.jobCardId]),
        staleSessions: mins >= STALE_SESSION_MIN ? 1 : 0,
      });
    }
  }

  return Array.from(byTech.entries())
    .map(([techId, v]) => ({
      techId,
      techName: v.name,
      totalMin: v.totalMin,
      carsTouched: v.cars.size,
      avgPerCarMin: v.cars.size > 0 ? v.totalMin / v.cars.size : 0,
      staleSessions: v.staleSessions,
    }))
    .sort((a, b) => b.totalMin - a.totalMin);
}

export async function techWrenchTime(
  garageIds: string[],
  range: { from: Date; to: Date },
): Promise<TechWrenchRow[]> {
  const rows = await prisma.workSession.findMany({
    where: {
      garageId: { in: garageIds },
      startedAt: { gte: range.from, lt: range.to },
    },
    select: {
      techId: true,
      tech: { select: { name: true } },
      jobCardId: true,
      startedAt: true,
      endedAt: true,
    },
    orderBy: { startedAt: "asc" },
  });

  const sessions = rows.map((r) => ({
    techId: r.techId,
    techName: r.tech.name,
    jobCardId: r.jobCardId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  }));

  return computeTechWrenchTime(sessions);
}
