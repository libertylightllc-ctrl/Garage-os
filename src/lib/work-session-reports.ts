import { prisma } from "@/lib/prisma";
import { SUSPICIOUS_SESSION_MS } from "@/lib/job-profit";

// Two thresholds. Kept intentionally distinct because they answer
// different operator questions.
//
//   STALE_SESSION_MIN (3h) — informational. "This session is long
//     enough that a supervisor should probably look at it." Rendered
//     as a ⚠ flag next to the row. Row STILL counts in totals.
//
//   SUSPICIOUS_SESSION_MIN (8h) — payroll-relevant. "This duration
//     exceeds any single legitimate shift; we don't trust it as
//     wrench-time." Row is EXCLUDED from totalMin / avgPerDayMin /
//     carsTouched aggregates and appears on a coverage line ("N of
//     M sessions excluded"). Matches the SUSPICIOUS_SESSION_MS rule
//     in job-profit.ts — same threshold, same "flag rather than cap
//     or rewrite" principle. Introduced AR 2026-08-20 after payroll
//     figures on the Hours screen were including a 33h AA0076
//     session (34h 1m total, 17h/day avg — a session nobody worked).
export const STALE_SESSION_MIN = 180; // 3 hours — flag, never discard
export const SUSPICIOUS_SESSION_MIN = SUSPICIOUS_SESSION_MS / 60_000; // 480 (8h) — exclude

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
  /** Sessions ≥8h that were EXCLUDED from totalMin / byTech totals. */
  excludedSessions: number;
  /** Total minutes those excluded sessions would have contributed. */
  excludedMin: number;
};

export type TechWrenchRow = {
  techId: string;
  techName: string;
  totalMin: number;
  carsTouched: number;
  avgPerCarMin: number;
  staleSessions: number;
  /** Sessions ≥8h excluded from this tech's totals. */
  excludedSessions: number;
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
    return {
      totalMin: 0, sessionCount: 0, byTech: [], stale: false,
      excludedSessions: 0, excludedMin: 0,
    };
  }

  const byTech = new Map<string, { name: string; totalMin: number; sessions: number }>();
  let totalMin = 0;
  let stale = false;
  let excludedSessions = 0;
  let excludedMin = 0;

  for (const s of sessions) {
    const mins = sessionMinutes(s, now);
    if (mins >= STALE_SESSION_MIN) stale = true;

    // Suspicious rows are excluded from totals (see
    // SUSPICIOUS_SESSION_MIN docstring). We track them so the UI
    // can show "N of M sessions excluded" instead of silently
    // shrinking the numbers.
    if (mins >= SUSPICIOUS_SESSION_MIN) {
      excludedSessions += 1;
      excludedMin += mins;
      continue;
    }

    totalMin += mins;
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
    excludedSessions,
    excludedMin,
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
    {
      name: string; totalMin: number; cars: Set<string>;
      staleSessions: number; excludedSessions: number;
    }
  >();

  for (const s of sessions) {
    const mins = sessionMinutes(s, now);
    const isStale = mins >= STALE_SESSION_MIN;
    const isSuspicious = mins >= SUSPICIOUS_SESSION_MIN;

    let existing = byTech.get(s.techId);
    if (!existing) {
      existing = {
        name: s.techName, totalMin: 0, cars: new Set(),
        staleSessions: 0, excludedSessions: 0,
      };
      byTech.set(s.techId, existing);
    }
    if (isStale) existing.staleSessions += 1;

    // Suspicious rows: excluded from totalMin + carsTouched, counted
    // in excludedSessions. carsTouched intentionally skips too — a
    // 33h session on one car shouldn't count that car as "touched"
    // in a way that inflates avgPerCarMin later.
    if (isSuspicious) {
      existing.excludedSessions += 1;
      continue;
    }
    existing.totalMin += mins;
    existing.cars.add(s.jobCardId);
  }

  return Array.from(byTech.entries())
    .map(([techId, v]) => ({
      techId,
      techName: v.name,
      totalMin: v.totalMin,
      carsTouched: v.cars.size,
      avgPerCarMin: v.cars.size > 0 ? v.totalMin / v.cars.size : 0,
      staleSessions: v.staleSessions,
      excludedSessions: v.excludedSessions,
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
  /** Sessions ≥8h excluded from totalMin / avgPerDayMin / per-day totals. */
  excludedSessions: number;
  /** Minutes those excluded sessions would have contributed. */
  excludedMin: number;
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
    return {
      days: [], totalMin: 0, totalCars: 0, totalDays: 0,
      avgPerDayMin: 0, staleSessions: 0,
      excludedSessions: 0, excludedMin: 0,
    };
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
  let excludedSessions = 0;
  let excludedMin = 0;

  for (const s of sessions) {
    const mins = sessionMinutes(s, now);
    const isStale = mins >= STALE_SESSION_MIN;
    const isSuspicious = mins >= SUSPICIOUS_SESSION_MIN;
    if (isStale) totalStale++;

    // Suspicious sessions (≥8h) are removed from every downstream
    // total — day totalMin, car totalMin, totalCars, avgPerDayMin.
    // Not silent: excludedSessions / excludedMin surface on the
    // Hours page's coverage line. Same "flag rather than
    // fabricate" rule as the profit card. AR 2026-08-20 — the 33h
    // AA0076 session was inflating avgPerDayMin to 17h/day.
    if (isSuspicious) {
      excludedSessions += 1;
      excludedMin += mins;
      continue;
    }

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
    excludedSessions,
    excludedMin,
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
