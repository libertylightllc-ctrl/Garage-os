import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { techDailyHistory } from "@/lib/work-session-reports";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { countryToTimeZone } from "@/lib/format-datetime";

export const dynamic = "force-dynamic";

function formatMin(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/**
 * Render a WorkSession clock time in the garage's timezone. Matches
 * the rest of the app's date formatting (garage tz, not viewer tz) so
 * a session at 09:15 Dubai reads as 09:15 no matter where the browser
 * happens to be. 24-hour so an early-morning 09:15 and an evening
 * 21:15 don't collide.
 */
function formatClock(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).format(d);
}

export default async function TechHoursLookupPage({
  searchParams,
}: {
  searchParams: Promise<{ tech?: string; from?: string; to?: string }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const garageId = session.user.garageId;

  const { tech: techId, from: fromStr, to: toStr } = await searchParams;

  // Fetch techs in THIS garage only (TECH + MASTER roles)
  const techs = await prisma.user.findMany({
    where: { garageId, role: { in: ["TECH", "MASTER"] } },
    select: { id: true, name: true, role: true },
    orderBy: { name: "asc" },
  });

  // Resolve selected tech (must belong to this garage)
  const selectedTech = techId ? techs.find((u) => u.id === techId) : null;

  // Parse date range
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  const defaultTo = new Date(defaultFrom.getTime() + 7 * 86_400_000);

  const from = fromStr ? new Date(fromStr + "T00:00:00") : defaultFrom;
  const to = toStr ? new Date(toStr + "T23:59:59") : defaultTo;

  // Fetch history if a valid tech is selected
  const history =
    selectedTech && !isNaN(from.getTime()) && !isNaN(to.getTime())
      ? await techDailyHistory(selectedTech.id, [garageId], { from, to })
      : null;

  // Garage's country → tz for the per-session clock rendering. Read
  // once, applied to every startedAt / endedAt below. Same tz the
  // dashboard uses for date + timestamp cells elsewhere.
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { country: true },
  });
  const tz = countryToTimeZone(garage?.country ?? "UAE");

  const stats = history
    ? [
        { label: t("techHoursTotalTime"), value: formatMin(history.totalMin) },
        { label: t("techHoursTotalCars"), value: String(history.totalCars) },
        { label: t("techHoursDays"), value: String(history.totalDays) },
        { label: t("techHoursAvgDay"), value: formatMin(history.avgPerDayMin) },
      ]
    : null;

  const backHref = session.user.role === "MASTER" ? "/advisor" : "/owner";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 lg:max-w-5xl">
      <AppNav role={session.user.role as "OWNER" | "MASTER"} active="hours" />

      <div className="flex items-center gap-3">
        <Link href={backHref} className="text-sm text-text-mute hover:text-text">
          <span className="inline-block rtl:-scale-x-100">←</span> {t("techHoursBack")}
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("techHoursLookupTitle")}
        </h1>
        <p className="text-sm text-text-mute">{t("techHoursLookupIntro")}</p>
      </div>

      {/* Picker form */}
      {techs.length === 0 ? (
        <p className="text-sm text-text-mute">{t("techHoursNoTechs")}</p>
      ) : (
        <form className="flex flex-wrap items-end gap-3 rounded-xl border border-border p-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("techHoursPickTech")}</span>
            <select
              name="tech"
              defaultValue={techId ?? ""}
              className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            >
              <option value="" disabled>
                —
              </option>
              {techs.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("techHoursPickFrom")}</span>
            <input
              type="date"
              name="from"
              defaultValue={fromStr ?? defaultFrom.toISOString().slice(0, 10)}
              className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("techHoursPickTo")}</span>
            <input
              type="date"
              name="to"
              defaultValue={toStr ?? defaultTo.toISOString().slice(0, 10)}
              className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>

          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center rounded-lg bg-brand-900 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
          >
            {t("techHoursLookupBtn")}
          </button>
        </form>
      )}

      {/* Results */}
      {history && selectedTech ? (
        <>
          <h2 className="text-lg font-semibold">
            {selectedTech.name} — {t("techHoursTitle")}
          </h2>

          {/* Stats cards */}
          {stats ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="flex flex-col rounded-xl border border-border bg-surface p-4">
                  <div className="text-xs font-medium text-text-mute">{s.label}</div>
                  <div className="mt-auto pt-1 text-lg font-semibold tabular-nums">{s.value}</div>
                </div>
              ))}
            </div>
          ) : null}

          {history.staleSessions > 0 ? (
            <p className="text-xs font-medium text-amber-600">
              ⚠ {t("wrenchStaleCount").replace("{n}", String(history.staleSessions))}
            </p>
          ) : null}

          {history.days.length === 0 ? (
            <p className="text-sm text-text-mute">{t("techHoursNone")}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {history.days.map((day) => (
                <section key={day.date} className="rounded-xl border border-border p-4">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-semibold">{day.date}</h2>
                    <span className="text-xs tabular-nums text-text-mute">
                      {formatMin(day.totalMin)} · {day.carsTouched} {day.carsTouched === 1 ? t("wrenchCar") : t("wrenchCars").toLowerCase()}
                      {day.staleSessions > 0 ? ` · ⚠ ${t("wrenchStaleCount").replace("{n}", String(day.staleSessions))}` : ""}
                    </span>
                  </div>

                  {/* Mobile: card list with per-session timings.
                      Each car is a summary line (make · plate · JC# ·
                      total) with its clock-time sessions under it —
                      "09:15 → 10:32 · 1h 17m" for each contiguous
                      stretch the tech spent on the car. A live
                      (unclosed) session shows "→ in progress". Times
                      are in the garage's tz, not the viewer's. */}
                  <ul className="flex flex-col gap-2 md:hidden">
                    {day.cars.map((c) => (
                      <li key={c.jobCardId} className="flex flex-col gap-1 rounded-lg border border-border/60 p-2.5 text-sm">
                        <div className="flex items-center justify-between">
                          <span>
                            <span className="font-medium">{c.vehicleMake}</span>
                            <span className="text-text-mute"> · {c.vehiclePlate}</span>
                            <span className="text-text-mute"> · {t("techHoursJob").replace("{n}", String(c.jobNumber))}</span>
                          </span>
                          <span className="tabular-nums text-text-mute">
                            {formatMin(c.totalMin)}
                            {c.stale ? " ⚠" : ""}
                          </span>
                        </div>
                        {c.sessions.length > 0 ? (
                          <ul className="ms-2 flex flex-col gap-0.5 text-xs text-text-mute">
                            {c.sessions.map((s, sIdx) => {
                              const sessionMin = s.endedAt
                                ? (s.endedAt.getTime() - s.startedAt.getTime()) / 60_000
                                : 0;
                              return (
                                <li key={sIdx} className="tabular-nums">
                                  {formatClock(s.startedAt, tz)}
                                  {" → "}
                                  {s.endedAt
                                    ? formatClock(s.endedAt, tz)
                                    : t("techHoursSessionLive")}
                                  {s.endedAt ? ` · ${formatMin(sessionMin)}` : ""}
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>

                  {/* Desktop: table. Sessions render inside a nested
                      row per car so the alignment across cars stays
                      consistent. Same per-session shape as the mobile
                      card. */}
                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-xs uppercase tracking-wide text-text-mute">
                          <th className="py-1.5 pe-3 text-start font-semibold">{t("wrenchCars")}</th>
                          <th className="py-1.5 px-2 text-start font-semibold">{t("techHoursJobCol")}</th>
                          <th className="py-1.5 px-2 text-start font-semibold">{t("techHoursSessionsCol")}</th>
                          <th className="py-1.5 px-2 text-end font-semibold">{t("techHoursTotalTime")}</th>
                          <th className="py-1.5 ps-2 text-end font-semibold">⚠</th>
                        </tr>
                      </thead>
                      <tbody>
                        {day.cars.map((c, i) => (
                          <tr key={c.jobCardId} className={"border-b border-border/60 align-top " + (i % 2 === 1 ? "bg-surface-2/40" : "")}>
                            <td className="py-1.5 pe-3 font-medium">{c.vehicleMake} · {c.vehiclePlate}</td>
                            <td className="py-1.5 px-2 text-text-mute">#{c.jobNumber}</td>
                            <td className="py-1.5 px-2 text-xs text-text-mute">
                              {c.sessions.length === 0 ? "—" : (
                                <ul className="flex flex-col gap-0.5">
                                  {c.sessions.map((s, sIdx) => {
                                    const sessionMin = s.endedAt
                                      ? (s.endedAt.getTime() - s.startedAt.getTime()) / 60_000
                                      : 0;
                                    return (
                                      <li key={sIdx} className="tabular-nums">
                                        {formatClock(s.startedAt, tz)}
                                        {" → "}
                                        {s.endedAt
                                          ? formatClock(s.endedAt, tz)
                                          : t("techHoursSessionLive")}
                                        {s.endedAt ? ` · ${formatMin(sessionMin)}` : ""}
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </td>
                            <td className="py-1.5 px-2 text-end tabular-nums">{formatMin(c.totalMin)}</td>
                            <td className="py-1.5 ps-2 text-end tabular-nums">
                              {c.stale ? <span className="text-amber-600">⚠</span> : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      ) : null}
    </main>
  );
}
