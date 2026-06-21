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
  advisorActivity,
} from "@/lib/owner-metrics";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

// Human-friendly minute formatter for the productivity table.
// 0–59 →"Xm"
// 60+  →"Xh Ym"(Y omitted when zero, e.g."2h"not"2h 0m")
// Negative inputs shouldn't happen (technicianWork clamps to 0) but
// guard anyway so a bad row never renders"−5m"to the owner.
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
  const gidArr = Array.isArray(garageId) ? garageId : [garageId];
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
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
        .map((r) => `${r.overdue ?"🔴":"🟡"} ${r.customer}: ${money(r.balance)}`)
        .join(";");
      return fill(t("ansOwes"), { n: String(rows.length), total: money(total), list });
    }
    case "WEEK_TREND": {
      const w = await weekTrend(garageId, now);
      const dir = w.delta > 0 ? t("dirUp") : w.delta < 0 ? t("dirDown") : t("dirFlat");
      return fill(t("ansTrend"), {
        dir,
        a: money(w.thisWeek),
        b: money(w.lastWeek),
        d: `${w.delta >= 0 ?"+":""}${money(w.delta)}`,
      });
    }
    // ── Slice #7 new intents ─────────────────────────────────────
    case "INVOICES_SUMMARY": {
      // This-month invoice rollup: count by status + total billed.
      // Status enum DRAFT|SENT|PAID|VOID; SENT covers unpaid+partial
      // (partial state is derived at render, not stored).
      const invs = await prisma.invoice.findMany({
        where: { garageId: { in: gidArr }, issuedAt: { gte: monthStart } },
        select: { status: true, total: true },
      });
      const total = invs.reduce((s, i) => s + Number(i.total), 0);
      const counts = { DRAFT: 0, SENT: 0, PAID: 0, VOID: 0 } as Record<string, number>;
      for (const i of invs) counts[i.status] = (counts[i.status] ?? 0) + 1;
      return fill(t("ansInvoiceSummary"), {
        n: String(invs.length),
        total: money(total),
        paid: String(counts.PAID),
        sent: String(counts.SENT),
        draft: String(counts.DRAFT),
        voided: String(counts.VOID),
      });
    }
    case "VAT_MONTH": {
      // VAT Payable is credit-normal in the ledger. Use the same
      // sumAccount math via a direct query (no need to import the
      // private helper) — month-to-date.
      const agg = await prisma.ledgerEntry.aggregate({
        where: {
          garageId: { in: gidArr },
          account:"VAT Payable",
          createdAt: { gte: monthStart },
        },
        _sum: { credit: true, debit: true },
      });
      const vat = Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0);
      return fill(t("ansVatMonth"), { v: money(vat) });
    }
    case "ADVANCES_OUTSTANDING": {
      // Advances received but not yet migrated to an invoice. These
      // are 'we owe the work' liabilities and are useful for the
      // owner to know at a glance.
      const open = await prisma.advancePayment.findMany({
        where: { garageId: { in: gidArr }, migratedAt: null },
        select: {
          amount: true,
          jobCard: { select: { vehicle: { select: { customer: { select: { name: true } } } } } },
        },
      });
      if (open.length === 0) return t("ansAdvancesNone");
      const total = open.reduce((s, a) => s + Number(a.amount), 0);
      // List by customer name, summed in case the same customer has
      // multiple open advances on different jobs.
      const byCustomer = new Map<string, number>();
      for (const a of open) {
        const n = a.jobCard.vehicle.customer.name;
        byCustomer.set(n, (byCustomer.get(n) ?? 0) + Number(a.amount));
      }
      const list = Array.from(byCustomer.entries())
        .map(([name, amt]) => `${name}: ${money(amt)}`)
        .join(";");
      return fill(t("ansAdvancesOpen"), {
        n: String(open.length),
        total: money(total),
        list,
      });
    }
    case "TECH_RANKING": {
      // Top tech by completed-job count (jobs field on TechWork).
      // technicianWork sorts by steps desc; resort by jobs for this
      // answer so 'top tech' aligns with what the owner actually
      // means (most jobs completed, not most JobSteps logged).
      const tw = await technicianWork(garageId);
      if (tw.length === 0) return t("ansTechRankingNone");
      const ranked = [...tw].sort((a, b) => b.jobs - a.jobs);
      const top = ranked.slice(0, 3);
      const list = top
        .map((r, i) => {
          const avg =
            r.avgTimePerJobMin === null
              ?"—"
              : r.avgTimePerJobMin >= 60
                ? `${Math.floor(r.avgTimePerJobMin / 60)}h${r.avgTimePerJobMin % 60 ? ` ${r.avgTimePerJobMin % 60}m` :""}`
                : `${r.avgTimePerJobMin}m`;
          return `${i + 1}. ${r.name}: ${r.jobs} jobs, ⏱ avg ${avg}`;
        })
        .join(";");
      return fill(t("ansTechRanking"), { list });
    }
    case "ADVISOR_RANKING": {
      // Top advisor by approval rate among advisors with at least 3
      // decided estimates (so a 1-for-1 advisor doesn't dominate at
      // 100% on a tiny sample). Falls back to most-jobs if no one
      // qualifies.
      const aw = await advisorActivity(garageId);
      if (aw.length === 0) return t("ansAdvisorRankingNone");
      const eligible = aw.filter(
        (a) => a.approvalRate !== null && a.approvedCount + a.rejectedCount >= 3,
      );
      const ranked =
        eligible.length > 0
          ? [...eligible].sort((a, b) => (b.approvalRate ?? 0) - (a.approvalRate ?? 0))
          : [...aw].sort((a, b) => b.jobsCreated - a.jobsCreated);
      const top = ranked.slice(0, 3);
      const list = top
        .map((r, i) => {
          const rate = r.approvalRate === null ?"—": `${r.approvalRate}%`;
          return `${i + 1}. ${r.name}: ${r.estimatesSent} sent, ${rate} approval`;
        })
        .join(";");
      return fill(t("ansAdvisorRanking"), { list });
    }
    case "LEDGER_BALANCE": {
      // Current Cash and AR balances (debit-normal, so net debit > 0
      // is a positive balance). Pull both in one query, partition by
      // account in JS.
      const entries = await prisma.ledgerEntry.findMany({
        where: {
          garageId: { in: gidArr },
          account: { in: ["Cash/Bank","Accounts Receivable"] },
        },
        select: { account: true, debit: true, credit: true },
      });
      let cash = 0;
      let ar = 0;
      for (const e of entries) {
        const net = Number(e.debit) - Number(e.credit);
        if (e.account ==="Cash/Bank") cash += net;
        else if (e.account ==="Accounts Receivable") ar += net;
      }
      return fill(t("ansLedgerBalance"), { cash: money(cash), ar: money(ar) });
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
  const advisorWork = await advisorActivity(gids);

  let answer: string | null = null;
  if (q && q.trim()) {
    answer = await answerCopilot(t, gids, q, now);
    await prisma.aiEvent.create({
      data: {
        garageId,
        userId: session.user.id,
        kind:"COPILOT",
        model:"copilot-rules",
        sourceType:"OWNER_QUESTION",
        tokensIn: 0,
        tokensOut: 0,
        costEstimate: 0,
        latencyMs: 0,
      },
    });
  }

  const metrics: { icon: string; key: MessageKey; value: string }[] = [
    { icon:"💰", key:"mRevenueMo", value: money(rev) },
    { icon:"📈", key:"mProfitMo", value: money(profit) },
    { icon:"🚗", key:"mCarsToday", value: String(cars) },
    { icon:"⭐", key:"mSatisfaction", value:"—"},
    { icon:"📦", key:"mInventory", value: `${inv.low} ${t("low")} / ${inv.total}` },
  ];

  const samples: MessageKey[] = ["sampleUpDown","sampleProfit","sampleOwes"];

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 lg:max-w-6xl xl:max-w-7xl">
      <AppNav role="OWNER" active="dashboard"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("ownerDashboard")}</h1>

      {/* Metric cards — equal heights via flex+grow so a longer label
          on one card doesn't make its neighbours shorter. text-2xl
          icon sized uniformly across all 5 cards. Value uses tabular-
          nums so digit widths line up between adjacent cards (e.g.
          revenue + profit decimals stack). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {metrics.map((m) => (
          <div
            key={m.key}
            className="flex h-full flex-col rounded-xl border border-border bg-surface p-4"
          >
            <div className="text-2xl leading-none" aria-hidden="true">{m.icon}</div>
            <div className="mt-2 text-xs font-medium text-text-mute">{t(m.key)}</div>
            <div className="mt-auto pt-1 text-lg font-semibold tabular-nums">{m.value}</div>
          </div>
        ))}
      </div>
      <p className="-mt-3 text-xs text-text-mute">
        {t("thisWeek")}: {money(trend.thisWeek)} ({trend.delta >= 0 ?"+":""}
        {money(trend.delta)} {t("vsLastWeek")}). {t("satisfactionSoon")}
      </p>

      {/* Copilot + pilot metrics — stacked on phones, side-by-side on lg+
          so the desktop horizontal canvas isn't wasted on two small panels
          alone. Each panel keeps its own rounded-xl border + p-4 so they
          read as separate cards inside the grid. */}
      <div className="grid gap-6 lg:grid-cols-2">
      {/* Copilot */}
      <div className="rounded-xl border border-border p-4">
        <h2 className="mb-2 text-sm font-medium">{t("askCopilot")}</h2>
        <form method="GET" className="flex gap-2">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder={t("sampleOwes")}
            className="flex-1 h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          />
          <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
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
                className="rounded-full border border-border px-3 py-1 text-xs text-text hover:bg-surface-2 dark:text-text-mute"
              >
                {s}
              </Link>
            );
          })}
        </div>
        {answer ? (
          <p className="mt-3 rounded-xl border border-border bg-surface-2 p-4 text-sm">{answer}</p>
        ) : null}
        <p className="mt-2 text-xs text-text-mute">{t("copilotReadonly")}</p>
      </div>

      {/* Pilot instrumentation + AI margin meter */}
      <div className="rounded-xl border border-border p-4 text-sm">
        <h2 className="mb-2 text-sm font-medium">{t("pilotMetrics")}</h2>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
          <li>
            {t("intakeAcceptance")}:{""}
            <span className="font-medium">
              {acceptance.rate === null ?"—": `${Math.round(acceptance.rate * 100)}%`}
            </span>{""}
            <span className="text-text-mute">
              ({acceptance.confirmed}/{acceptance.confirmed + acceptance.rejected})
            </span>
          </li>
          <li>
            {t("avgConfirm")}:{""}
            <span className="font-medium">
              {confirmMins === null ?"—": `${confirmMins} ${t("min")}`}
            </span>
          </li>
          {/* AI cost (dollar figure) intentionally hidden from the
              owner view — it's the platform operator's per-call running
              cost, not a metric a garage owner should see. Call count
              stays since 'how much is the AI doing for me' is a fair
              owner question; the dollar figure lives in admin /
              platform metrics only. */}
          <li>
            {t("aiCalls")}: <span className="font-medium">{usage.events}</span>
          </li>
        </ul>
      </div>
      </div>

      {/* Activity tables — tech productivity + advisor performance.
          Same lg:grid-cols-2 pattern as the copilot+pilot row so the
          two read in parallel at desktop width. Each table keeps its
          own overflow-x-auto wrapper so columns scroll inside the
          panel rather than pushing the page wider. */}
      <div className="grid gap-6 lg:grid-cols-2">
      {/* Per-technician productivity — slice #3 adds time math:
            ⏱ avg = mean (workCompletedAt − claimedAt) across completed jobs
            today⏱ = sum of durations for jobs completed today (UTC day)
            today# = count of jobs completed today
          Existing columns (jobs/steps/photos/voice/parts/finishes)
          stay so the owner doesn't lose their existing read of the
          table. */}
      <div className="rounded-xl border border-border p-4">
        <h2 className="mb-2 text-sm font-medium">{t("techActivity")}</h2>
        {techWork.length === 0 ? (
          <p className="text-sm text-text-mute">{t("noTechActivity")}</p>
        ) : (
          <>
          {/* Phone fallback — the 10-column table doesn't fit on a
              380 px viewport, so below md we reflow each row into a
              stacked card with explicit labels for every stat. The
              icon-only columns from the desktop table (📷 / 🎤 / 📦 /
              ✅) get full word labels on the card so the owner doesn't
              have to long-press a glyph to know what it means. */}
          <ul className="flex flex-col gap-2 md:hidden">
            {techWork.map((tw) => (
              <li key={tw.techId} className="rounded-xl border border-border p-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{tw.name}</span>
                  <span className="tabular-nums text-xs text-text-mute">
                    {tw.jobs} {t("colJobs")}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-mute">
                  <dt>⏱ {t("colAvgShort")}</dt>
                  <dd className="text-end tabular-nums text-text">
                    {tw.avgTimePerJobMin === null ?"—": formatMin(tw.avgTimePerJobMin)}
                  </dd>
                  <dt>{t("colTodayTime")}</dt>
                  <dd className="text-end tabular-nums text-text">
                    {tw.totalTimeTodayMin > 0 ? formatMin(tw.totalTimeTodayMin) :"—"}
                  </dd>
                  <dt>{t("colTodayJobs")}</dt>
                  <dd className="text-end tabular-nums text-text">{tw.jobsToday}</dd>
                  <dt>{t("colSteps")}</dt>
                  <dd className="text-end tabular-nums text-text">{tw.steps}</dd>
                  <dt>📷 {t("colPhotosTitle")}</dt>
                  <dd className="text-end tabular-nums text-text">{tw.photos}</dd>
                  <dt>🎤 {t("colVoiceTitle")}</dt>
                  <dd className="text-end tabular-nums text-text">{tw.voice}</dd>
                  <dt>📦 {t("colPartsTitle")}</dt>
                  <dd className="text-end tabular-nums text-text">{tw.parts}</dd>
                  <dt>✅ {t("colFinishesTitle")}</dt>
                  <dd className="text-end tabular-nums text-text">{tw.finishes}</dd>
                </dl>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                {/* Header row — bottom border separates head from body
                    cleanly without per-cell tone juggling. Text-mute
                    label colour; uppercase tracking for 'this is a
                    column header' affordance. */}
                <tr className="border-b border-border text-xs uppercase tracking-wide text-text-mute">
                  <th className="py-2 pe-3 text-start font-semibold">{t("colTechnician")}</th>
                  <th className="py-2 px-2 text-end font-semibold">{t("colJobs")}</th>
                  <th className="py-2 px-2 text-end font-semibold" title={t("colAvgTimeTitle")}>
                    ⏱ {t("colAvgShort")}
                  </th>
                  <th className="py-2 px-2 text-end font-semibold" title={t("colTodayTimeTitle")}>
                    {t("colTodayTime")}
                  </th>
                  <th className="py-2 px-2 text-end font-semibold" title={t("colTodayJobsTitle")}>
                    {t("colTodayJobs")}
                  </th>
                  <th className="py-2 px-2 text-end font-semibold">{t("colSteps")}</th>
                  {/* Icon-only columns get a title= so a long-press /
                      hover reveals what the icon means; aria-label for
                      screen readers. Renders as the icon glyph but is
                      keyboard / a11y accessible. */}
                  <th className="py-2 px-2 text-end font-semibold" title={t("colPhotosTitle")} aria-label={t("colPhotosTitle")}>📷</th>
                  <th className="py-2 px-2 text-end font-semibold" title={t("colVoiceTitle")} aria-label={t("colVoiceTitle")}>🎤</th>
                  <th className="py-2 px-2 text-end font-semibold" title={t("colPartsTitle")} aria-label={t("colPartsTitle")}>📦</th>
                  <th className="py-2 ps-2 text-end font-semibold" title={t("colFinishesTitle")} aria-label={t("colFinishesTitle")}>✅</th>
                </tr>
              </thead>
              <tbody>
                {techWork.map((tw, i) => (
                  <tr
                    key={tw.techId}
                    className={
                      "border-b border-border/60 " +
                      (i % 2 === 1 ? "bg-surface-2/40" : "")
                    }
                  >
                    <td className="py-2 pe-3 font-medium">{tw.name}</td>
                    <td className="py-2 px-2 text-end tabular-nums">{tw.jobs}</td>
                    <td className="py-2 px-2 text-end tabular-nums">
                      {tw.avgTimePerJobMin === null ?"—": formatMin(tw.avgTimePerJobMin)}
                    </td>
                    <td className="py-2 px-2 text-end tabular-nums">
                      {tw.totalTimeTodayMin > 0 ? formatMin(tw.totalTimeTodayMin) :"—"}
                    </td>
                    <td className="py-2 px-2 text-end tabular-nums">{tw.jobsToday}</td>
                    <td className="py-2 px-2 text-end tabular-nums">{tw.steps}</td>
                    <td className="py-2 px-2 text-end tabular-nums">{tw.photos}</td>
                    <td className="py-2 px-2 text-end tabular-nums">{tw.voice}</td>
                    <td className="py-2 px-2 text-end tabular-nums">{tw.parts}</td>
                    <td className="py-2 ps-2 text-end tabular-nums">{tw.finishes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>

      {/* Per-advisor activity — slice #4. Same shape as the tech
          table so the owner reads them in parallel:
            jobs   — JobCard rows the advisor created (intake handoff)
            sent   — estimates with sentAt set (preview→send fired)
            ✓ / ✗  — customer-decided counts (APPROVED / REJECTED)
            rate   — approval % of decided estimates (— when none)
            ⏱ avg  — mean time customer sat on a quote before
                      deciding (sentAt → approvedAt). null=— rendered
                      when the advisor has no approvals yet. */}
      <div className="rounded-xl border border-border p-4">
        <h2 className="mb-2 text-sm font-medium">{t("advisorActivity")}</h2>
        {advisorWork.length === 0 ? (
          <p className="text-sm text-text-mute">
            {t("noAdvisorActivity")}
          </p>
        ) : (
          <>
          {/* Phone fallback — same reflow pattern as the tech card
              list above: stacked card per advisor with full-word
              labels in place of the ✓ / ✗ icon-only columns from the
              desktop table. Success / danger semantic colours kept on
              the ✓ / ✗ values. */}
          <ul className="flex flex-col gap-2 md:hidden">
            {advisorWork.map((a) => (
              <li key={a.advisorId} className="rounded-xl border border-border p-3 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{a.name}</span>
                  <span className="tabular-nums text-xs text-text-mute">
                    {a.jobsCreated} {t("colJobs")}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-mute">
                  <dt>{t("colEstimatesSent")}</dt>
                  <dd className="text-end tabular-nums text-text">{a.estimatesSent}</dd>
                  <dt>✓ {t("colApprovedTitle")}</dt>
                  <dd className="text-end tabular-nums font-semibold text-success-700 dark:text-success-500">
                    {a.approvedCount}
                  </dd>
                  <dt>✗ {t("colRejectedTitle")}</dt>
                  <dd className="text-end tabular-nums font-semibold text-danger-700 dark:text-danger-500">
                    {a.rejectedCount}
                  </dd>
                  <dt>{t("colApprovalRate")}</dt>
                  <dd className="text-end tabular-nums text-text">
                    {a.approvalRate === null ?"—": `${a.approvalRate}%`}
                  </dd>
                  <dt>⏱ {t("colApprovalTimeShort")}</dt>
                  <dd className="text-end tabular-nums text-text">
                    {a.avgApprovalMin === null ?"—": formatMin(a.avgApprovalMin)}
                  </dd>
                </dl>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-text-mute">
                  <th className="py-2 pe-3 text-start font-semibold">{t("colAdvisor")}</th>
                  <th className="py-2 px-2 text-end font-semibold">{t("colJobs")}</th>
                  <th className="py-2 px-2 text-end font-semibold">{t("colEstimatesSent")}</th>
                  <th className="py-2 px-2 text-end font-semibold" title={t("colApprovedTitle")} aria-label={t("colApprovedTitle")}>✓</th>
                  <th className="py-2 px-2 text-end font-semibold" title={t("colRejectedTitle")} aria-label={t("colRejectedTitle")}>✗</th>
                  <th className="py-2 px-2 text-end font-semibold" title={t("colApprovalRateTitle")}>
                    {t("colApprovalRate")}
                  </th>
                  <th className="py-2 ps-2 text-end font-semibold" title={t("colApprovalTimeTitle")}>
                    ⏱ {t("colApprovalTimeShort")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {advisorWork.map((a, i) => (
                  <tr
                    key={a.advisorId}
                    className={
                      "border-b border-border/60 " +
                      (i % 2 === 1 ? "bg-surface-2/40" : "")
                    }
                  >
                    <td className="py-2 pe-3 font-medium">{a.name}</td>
                    <td className="py-2 px-2 text-end tabular-nums">{a.jobsCreated}</td>
                    <td className="py-2 px-2 text-end tabular-nums">{a.estimatesSent}</td>
                    {/* ✓ / ✗ counts in semantic palette (success /
                        danger), aligned with the rest of the app's
                        green=success / red=rejected convention. */}
                    <td className="py-2 px-2 text-end tabular-nums font-semibold text-success-700 dark:text-success-500">
                      {a.approvedCount}
                    </td>
                    <td className="py-2 px-2 text-end tabular-nums font-semibold text-danger-700 dark:text-danger-500">
                      {a.rejectedCount}
                    </td>
                    <td className="py-2 px-2 text-end tabular-nums">
                      {a.approvalRate === null ?"—": `${a.approvalRate}%`}
                    </td>
                    <td className="py-2 ps-2 text-end tabular-nums">
                      {a.avgApprovalMin === null ?"—": formatMin(a.avgApprovalMin)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
      </div>
    </main>
  );
}
