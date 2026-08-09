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

// ---------------------------------------------------------------------------
// Slice 3 — per-tech daily work history (read-only analytics)
// ---------------------------------------------------------------------------

export type CarEntry = {
  jobCardId: string;
  jobNumber: number;
  vehicleMake: string;
  vehiclePlate: string;
  totalMin: number;
  stale: boolean;
  // Raw session boundaries for this car on this day. Ordered
  // chronologically (earliest first) so the render can walk them
  // in the order the tech actually worked. endedAt=null means the
  // tech is still on the car (live session).
  sessions: { startedAt: Date; endedAt: Date | null }[];
};

export type DayRow = {
  date: string; // YYYY-MM-DD (in the supplied tz offset)
  totalMin: number;
  carsTouched: number;
  cars: CarEntry[];
  staleSessions: number;
};

export type TechDailyHistory = {
  days: DayRow[];
  totalMin: number;
  totalCars: number;
  totalDays: number;
  avgPerDayMin: number;
  staleSessions: number;
};

type HistorySession = {
  jobCardId: string;
  jobNumber: number;
  vehicleMake: string;
  vehiclePlate: string;
  startedAt: Date;
  endedAt: Date | null;
};

/**
 * Group one tech's sessions into calendar days. `tzOffsetMin` is the
 * minutes-ahead-of-UTC for the garage's timezone (UAE = +240). Day
 * boundaries use this offset so "today" means the garage's today, not UTC.
 */
export function computeTechDailyHistory(
  sessions: HistorySession[],
  now: Date = new Date(),
  tzOffsetMin: number = 240, // UAE +4h default
): TechDailyHistory {
  if (sessions.length === 0) {
    return { days: [], totalMin: 0, totalCars: 0, totalDays: 0, avgPerDayMin: 0, staleSessions: 0 };
  }

  const dayKey = (d: Date): string => {
    const shifted = new Date(d.getTime() + tzOffsetMin * 60_000);
    return shifted.toISOString().slice(0, 10);
  };

  const dayMap = new Map<string, {
    carMap: Map<string, {
      jobNumber: number;
      make: string;
      plate: string;
      totalMin: number;
      stale: boolean;
      sessions: { startedAt: Date; endedAt: Date | null }[];
    }>;
    totalMin: number;
    staleSessions: number;
  }>();

  const allCars = new Set<string>();
  let totalStale = 0;

  for (const s of sessions) {
    const mins = sessionMinutes(s, now);
    const isStale = mins >= STALE_SESSION_MIN;
    if (isStale) totalStale++;
    const key = dayKey(s.startedAt);
    allCars.add(s.jobCardId);

    let day = dayMap.get(key);
    if (!day) {
      day = { carMap: new Map(), totalMin: 0, staleSessions: 0 };
      dayMap.set(key, day);
    }
    day.totalMin += mins;
    if (isStale) day.staleSessions++;

    const car = day.carMap.get(s.jobCardId);
    if (car) {
      car.totalMin += mins;
      if (isStale) car.stale = true;
      car.sessions.push({ startedAt: s.startedAt, endedAt: s.endedAt });
    } else {
      day.carMap.set(s.jobCardId, {
        jobNumber: s.jobNumber,
        make: s.vehicleMake,
        plate: s.vehiclePlate,
        totalMin: mins,
        stale: isStale,
        sessions: [{ startedAt: s.startedAt, endedAt: s.endedAt }],
      });
    }
  }

  const days: DayRow[] = Array.from(dayMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0])) // newest first
    .map(([date, d]) => ({
      date,
      totalMin: d.totalMin,
      carsTouched: d.carMap.size,
      cars: Array.from(d.carMap.entries())
        .map(([jobCardId, c]) => ({
          jobCardId,
          jobNumber: c.jobNumber,
          vehicleMake: c.make,
          vehiclePlate: c.plate,
          totalMin: c.totalMin,
          stale: c.stale,
          // Chronological within a car — earliest session first, matches
          // how the tech actually worked the day.
          sessions: [...c.sessions].sort(
            (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
          ),
        }))
        .sort((a, b) => b.totalMin - a.totalMin),
      staleSessions: d.staleSessions,
    }));

  const totalMin = days.reduce((s, d) => s + d.totalMin, 0);
  const totalDays = days.length;

  return {
    days,
    totalMin,
    totalCars: allCars.size,
    totalDays,
    avgPerDayMin: totalDays > 0 ? totalMin / totalDays : 0,
    staleSessions: totalStale,
  };
}

export async function techDailyHistory(
  techId: string,
  garageIds: string[],
  range: { from: Date; to: Date },
  tzOffsetMin: number = 240,
): Promise<TechDailyHistory> {
  const rows = await prisma.workSession.findMany({
    where: {
      techId,
      garageId: { in: garageIds },
      startedAt: { gte: range.from, lt: range.to },
    },
    select: {
      jobCardId: true,
      jobCard: { select: { number: true, vehicle: { select: { make: true, plate: true } } } },
      startedAt: true,
      endedAt: true,
    },
    orderBy: { startedAt: "asc" },
  });

  const sessions: HistorySession[] = rows.map((r) => ({
    jobCardId: r.jobCardId,
    jobNumber: r.jobCard.number ?? 0,
    vehicleMake: r.jobCard.vehicle.make,
    vehiclePlate: r.jobCard.vehicle.plate,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  }));

  return computeTechDailyHistory(sessions, new Date(), tzOffsetMin);
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
