import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { companyGarageIds } from "@/lib/branches";
import { techDailyHistory } from "@/lib/work-session-reports";
import { AppNav } from "@/components/app-nav";
import { getT, getLocale } from "@/i18n/server";
import { pluralize } from "@/i18n/plural";
import type { MessageKey } from "@/i18n/config";

export const dynamic = "force-dynamic";

function formatMin(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export default async function TechHoursPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const locale = await getLocale();
  const { userId } = await params;
  const { range } = await searchParams;

  const garageId = session.user.garageId;
  const gids = await companyGarageIds(garageId);

  const tech = await prisma.user.findFirst({
    where: { id: userId, garageId: { in: gids } },
    select: { id: true, name: true, role: true },
  });
  if (!tech) notFound();

  const now = new Date();
  const rangeMode = range === "month" ? "month" : "week";
  const from =
    rangeMode === "month"
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  const to =
    rangeMode === "month"
      ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
      : new Date(from.getTime() + 7 * 86_400_000);

  const history = await techDailyHistory(tech.id, gids, { from, to });

  const stats: { key: MessageKey; value: string }[] = [
    { key: "techHoursTotalTime", value: formatMin(history.totalMin) },
    { key: "techHoursTotalCars", value: String(history.totalCars) },
    { key: "techHoursDays", value: String(history.totalDays) },
    { key: "techHoursAvgDay", value: formatMin(history.avgPerDayMin) },
  ];

  const backHref = session.user.role === "MASTER" ? "/advisor" : "/owner/staff";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 lg:max-w-5xl">
      <AppNav role={session.user.role as "OWNER" | "MASTER"} active="team" />

      <div className="flex items-center gap-3">
        <Link href={backHref} className="text-sm text-text-mute hover:text-text">
          <span className="inline-block rtl:-scale-x-100">←</span> {t("techHoursBack")}
        </Link>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {tech.name} — {t("techHoursTitle")}
        </h1>
        <div className="flex gap-1 text-xs">
          <Link
            href={`/owner/staff/${userId}/hours?range=week`}
            className={`rounded-lg px-2 py-0.5 ${rangeMode === "week" ? "bg-surface-2 font-semibold text-text" : "text-text-mute hover:text-text"}`}
          >
            {t("techHoursWeek")}
          </Link>
          <Link
            href={`/owner/staff/${userId}/hours?range=month`}
            className={`rounded-lg px-2 py-0.5 ${rangeMode === "month" ? "bg-surface-2 font-semibold text-text" : "text-text-mute hover:text-text"}`}
          >
            {t("techHoursMonth")}
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.key} className="flex flex-col rounded-xl border border-border bg-surface p-4">
            <div className="text-xs font-medium text-text-mute">{t(s.key)}</div>
            <div className="mt-auto pt-1 text-lg font-semibold tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>

      {history.staleSessions > 0 ? (
        <p className="text-xs font-medium text-amber-600">
          ⚠ {pluralize(t, history.staleSessions, "wrenchStaleCount", locale)}
        </p>
      ) : null}

      {history.excludedSessions > 0 ? (
        <p className="text-xs font-medium text-amber-600">
          🚫 {t("wrenchExcludedCount")
            .replace("{n}", String(history.excludedSessions))
            .replace("{mins}", formatMin(history.excludedMin))}
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
                  {day.staleSessions > 0 ? ` · ⚠ ${pluralize(t, day.staleSessions, "wrenchStaleCount", locale)}` : ""}
                </span>
              </div>

              {/* Mobile: card list */}
              <ul className="flex flex-col gap-2 md:hidden">
                {day.cars.map((c) => (
                  <li key={c.jobCardId} className="flex items-center justify-between rounded-lg border border-border/60 p-2.5 text-sm">
                    <span>
                      <span className="font-medium">{c.vehicleMake}</span>
                      <span className="text-text-mute"> · {c.vehiclePlate}</span>
                      <span className="text-text-mute"> · {t("techHoursJob").replace("{n}", String(c.jobNumber))}</span>
                    </span>
                    <span className="tabular-nums text-text-mute">
                      {formatMin(c.totalMin)}
                      {c.stale ? " ⚠" : ""}
                    </span>
                  </li>
                ))}
              </ul>

              {/* Desktop: table */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-text-mute">
                      <th className="py-1.5 pe-3 text-start font-semibold">{t("wrenchCars")}</th>
                      <th className="py-1.5 px-2 text-start font-semibold">{t("techHoursJobCol")}</th>
                      <th className="py-1.5 px-2 text-end font-semibold">{t("techHoursTotalTime")}</th>
                      <th className="py-1.5 ps-2 text-end font-semibold">⚠</th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.cars.map((c, i) => (
                      <tr key={c.jobCardId} className={"border-b border-border/60 " + (i % 2 === 1 ? "bg-surface-2/40" : "")}>
                        <td className="py-1.5 pe-3 font-medium">{c.vehicleMake} · {c.vehiclePlate}</td>
                        <td className="py-1.5 px-2 text-text-mute">#{c.jobNumber}</td>
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
    </main>
  );
}
