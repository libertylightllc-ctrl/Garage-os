import type { JobTimeSummary } from "@/lib/work-session-reports";
import type { MessageKey } from "@/i18n/config";

function formatMin(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export function JobTimePanel({
  summary,
  t,
}: {
  summary: JobTimeSummary;
  t: (k: MessageKey) => string;
}) {
  if (summary.sessionCount === 0) {
    return (
      <div className="rounded-xl border border-border p-3">
        <h2 className="text-sm font-medium">{t("workshopTime")}</h2>
        <p className="mt-1 text-xs text-text-mute">{t("workshopTimeNone")}</p>
      </div>
    );
  }

  const hasLive = summary.byTech.some((bt) =>
    bt.totalMin > 0 && summary.sessionCount > 0,
  );

  const summaryText = t("workshopTimeSummary")
    .replace("{time}", formatMin(summary.totalMin))
    .replace("{n}", String(summary.sessionCount));

  return (
    <div className="rounded-xl border border-border p-3">
      <h2 className="text-sm font-medium">{t("workshopTime")}</h2>
      <p className="mt-1 text-sm tabular-nums">
        {summaryText}
      </p>
      {summary.stale ? (
        <p className="mt-1 text-xs font-medium text-amber-600">
          ⚠ {t("workshopTimeStale")}
        </p>
      ) : null}
      {summary.byTech.length > 1 ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-mute">
          {summary.byTech.map((bt) => (
            <li key={bt.techId} className="tabular-nums">
              {bt.techName} {formatMin(bt.totalMin)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
