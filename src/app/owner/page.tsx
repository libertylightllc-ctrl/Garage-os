import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { classifyIntent } from "@/lib/copilot";
import { companyGarageIds } from "@/lib/branches";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import {
  revenue,
  profitThisMonth,
  carsToday,
  inventoryHealth,
  weekTrend,
  whoOwes,
  aiUsage,
  intakeAcceptance,
  avgConfirmMinutes,
  technicianWork,
} from "@/lib/owner-metrics";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

// Human-friendly minute formatter for the productivity table.
// 0–59  → "Xm"
// 60+   → "Xh Ym"  (Y omitted when zero, e.g. "2h" not "2h 0m")
// Negative inputs shouldn't happen (technicianWork clamps to 0) but
// guard anyway so a bad row never renders "−5m" to the owner.
function formatMin(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}
type T = (k: MessageKey) => string;

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

async function answerCopilot(t: T, garageId: string | string[], question: string, now: Date): Promise<string> {
  switch (classifyIntent(question)) {
    case "PROFIT_MONTH": {
      const p = await profitThisMonth(garageId, now);
      return fill(t("ansProfit"), { v: money(p) });
    }
    case "WHO_OWES": {
      const rows = await whoOwes(garageId, now);
      if (rows.length === 0) return t("ansNobodyOwes");
      const total = rows.reduce((s, r) => s + r.balance, 0);
      const list = rows
        .map((r) => `${r.overdue ? "🔴" : "🟡"} ${r.customer}: ${money(r.balance)}`)
        .join("; ");
      return fill(t("ansOwes"), { n: String(rows.length), total: money(total), list });
    }
    case "WEEK_TREND": {
      const w = await weekTrend(garageId, now);
      const dir = w.delta > 0 ? t("dirUp") : w.delta < 0 ? t("dirDown") : t("dirFlat");
      return fill(t("ansTrend"), {
        dir,
        a: money(w.thisWeek),
        b: money(w.lastWeek),
        d: `${w.delta >= 0 ? "+" : ""}${money(w.delta)}`,
      });
    }
    default:
      return t("copilotUnknown");
  }
}

export default async function OwnerHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const garageId = session.user.garageId;
  // Owner sees ALL branches aggregated (company root + its branches).
  const gids = await companyGarageIds(garageId);
  const now = new Date();
  const { q } = await searchParams;

  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const [rev, profit, cars, inv, trend, usage, acceptance, confirmMins, techWork] =
    await Promise.all([
      revenue(gids, monthFrom),
      profitThisMonth(gids, now),
      carsToday(gids, now),
      inventoryHealth(gids),
      weekTrend(gids, now),
      aiUsage(gids, monthFrom),
      intakeAcceptance(gids),
      avgConfirmMinutes(gids),
      technicianWork(gids),
    ]);

  let answer: string | null = null;
  if (q && q.trim()) {
    answer = await answerCopilot(t, gids, q, now);
    await prisma.aiEvent.create({
      data: {
        garageId,
        userId: session.user.id,
        kind: "COPILOT",
        model: "copilot-rules",
        sourceType: "OWNER_QUESTION",
        tokensIn: 0,
        tokensOut: 0,
        costEstimate: 0,
        latencyMs: 0,
      },
    });
  }

  const metrics: { icon: string; key: MessageKey; value: string }[] = [
    { icon: "💰", key: "mRevenueMo", value: money(rev) },
    { icon: "📈", key: "mProfitMo", value: money(profit) },
    { icon: "🚗", key: "mCarsToday", value: String(cars) },
    { icon: "⭐", key: "mSatisfaction", value: "—" },
    { icon: "📦", key: "mInventory", value: `${inv.low} ${t("low")} / ${inv.total}` },
  ];

  const samples: MessageKey[] = ["sampleUpDown", "sampleProfit", "sampleOwes"];

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="dashboard" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("ownerDashboard")}</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {metrics.map((m) => (
          <div key={m.key} className="rounded-xl border border-black/10 p-3 dark:border-white/15">
            <div className="text-2xl">{m.icon}</div>
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t(m.key)}</div>
            <div className="text-base font-semibold">{m.value}</div>
          </div>
        ))}
      </div>
      <p className="-mt-3 text-xs text-zinc-400">
        {t("thisWeek")}: {money(trend.thisWeek)} ({trend.delta >= 0 ? "+" : ""}
        {money(trend.delta)} {t("vsLastWeek")}). {t("satisfactionSoon")}
      </p>

      {/* Copilot */}
      <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
        <h2 className="mb-2 text-sm font-medium">{t("askCopilot")}</h2>
        <form method="GET" className="flex gap-2">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder={t("sampleOwes")}
            className="flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
          />
          <button className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black">
            {t("ask")}
          </button>
        </form>
        <div className="mt-2 flex flex-wrap gap-2">
          {samples.map((key) => {
            const s = t(key);
            return (
              <Link
                key={key}
                href={`/owner?q=${encodeURIComponent(s)}`}
                className="rounded-full border border-black/10 px-3 py-1 text-xs text-zinc-600 hover:bg-black/5 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/10"
              >
                {s}
              </Link>
            );
          })}
        </div>
        {answer ? (
          <p className="mt-3 rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">{answer}</p>
        ) : null}
        <p className="mt-2 text-xs text-zinc-400">{t("copilotReadonly")}</p>
      </div>

      {/* Pilot instrumentation + AI margin meter */}
      <div className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
        <h2 className="mb-2 text-sm font-medium">{t("pilotMetrics")}</h2>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
          <li>
            {t("intakeAcceptance")}:{" "}
            <span className="font-medium">
              {acceptance.rate === null ? "—" : `${Math.round(acceptance.rate * 100)}%`}
            </span>{" "}
            <span className="text-zinc-400">
              ({acceptance.confirmed}/{acceptance.confirmed + acceptance.rejected})
            </span>
          </li>
          <li>
            {t("avgConfirm")}:{" "}
            <span className="font-medium">
              {confirmMins === null ? "—" : `${confirmMins} ${t("min")}`}
            </span>
          </li>
          <li>
            {t("aiCalls")}: <span className="font-medium">{usage.events}</span>
          </li>
          <li>
            {t("aiCost")}: <span className="font-medium">${usage.costUsd.toFixed(4)}</span>
          </li>
        </ul>
        <p className="mt-2 text-xs text-zinc-400">{t("aiCostNote")}</p>
      </div>

      {/* Per-technician productivity — slice #3 adds time math:
            ⏱ avg = mean (workCompletedAt − claimedAt) across completed jobs
            today⏱ = sum of durations for jobs completed today (UTC day)
            today# = count of jobs completed today
          Existing columns (jobs/steps/photos/voice/parts/finishes)
          stay so the owner doesn't lose their existing read of the
          table. */}
      <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
        <h2 className="mb-2 text-sm font-medium">{t("techActivity")}</h2>
        {techWork.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("noTechActivity")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500 dark:text-zinc-400">
                  <th className="py-1 pe-3">{t("colTechnician")}</th>
                  <th className="py-1 px-2 text-right">{t("colJobs")}</th>
                  <th className="py-1 px-2 text-right" title={t("colAvgTimeTitle")}>⏱ avg</th>
                  <th className="py-1 px-2 text-right" title={t("colTodayTimeTitle")}>today ⏱</th>
                  <th className="py-1 px-2 text-right" title={t("colTodayJobsTitle")}>today #</th>
                  <th className="py-1 px-2 text-right">{t("colSteps")}</th>
                  <th className="py-1 px-2 text-right">📷</th>
                  <th className="py-1 px-2 text-right">🎤</th>
                  <th className="py-1 px-2 text-right">📦</th>
                  <th className="py-1 ps-2 text-right">✅</th>
                </tr>
              </thead>
              <tbody>
                {techWork.map((tw) => (
                  <tr key={tw.techId} className="border-t border-black/5 dark:border-white/10">
                    <td className="py-1 pe-3 font-medium">{tw.name}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{tw.jobs}</td>
                    <td className="py-1 px-2 text-right tabular-nums">
                      {tw.avgTimePerJobMin === null ? "—" : formatMin(tw.avgTimePerJobMin)}
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums">
                      {tw.totalTimeTodayMin > 0 ? formatMin(tw.totalTimeTodayMin) : "—"}
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums">{tw.jobsToday}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{tw.steps}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{tw.photos}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{tw.voice}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{tw.parts}</td>
                    <td className="py-1 ps-2 text-right tabular-nums">{tw.finishes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
