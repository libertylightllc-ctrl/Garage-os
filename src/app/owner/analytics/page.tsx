import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { companyGarageIds } from "@/lib/branches";
import { getT } from "@/i18n/server";
import { computeDailyAnalytics } from "@/lib/analytics-daily";
import { computePeriodProfit } from "@/lib/period-profit";
import { PeriodProfitCard } from "@/components/period-profit-card";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
  * Owner analytics + charts — slice #6.
  *
  * Daily series over the last N days (default 30):
  *  - Revenue per day (credit-normal Sales)
  *  - VAT collected per day (credit-normal VAT Payable)
  *  - Jobs created per day (JobCard.createdAt)
  *  - Average ticket size per day (invoice.total / invoice count)
  *
  * Charts: inline SVG bars/line, no external lib. Keeps the bundle
  * lean and renders identically in print. ?days= URL param drives the
  * window (7 / 14 / 30 / 90 / 365); links at the top swap it.
  */

const VALID_DAYS = new Set([7, 14, 30, 90, 365]);

export default async function OwnerAnalytics({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const gids = await companyGarageIds(session.user.garageId);
  const { days: rawDays } = await searchParams;
  const days = (() => {
    const n = Number(rawDays);
    return Number.isFinite(n) && VALID_DAYS.has(n) ? n : 30;
  })();

  // Aggregation extracted to src/lib/analytics-daily.ts so the CSV
  // export route hits the exact same numbers (AR 2026-08-21).
  const { series, totals } = await computeDailyAnalytics(gids, days);

  // Per-period profit widget (AR 2026-08-22, profit reporting Step 6).
  // Runs a second query set — same range, different math: reads
  // frozen InvoiceLine.unitCost via computeJobProfit per invoice
  // instead of the ledger's Sales Revenue - Part.cost naive
  // subtraction. See src/lib/period-profit.ts for why we can't
  // reuse the ledger totals for this reading (missing-cost signal
  // is lost in the aggregate).
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const periodProfit = await computePeriodProfit(gids, from, now);
  const revenueTotal = totals.revenue;
  const vatTotal = totals.vat;
  const jobsTotal = totals.jobs;
  const invSumTotal = totals.invoiceSum;
  const invCountTotal = totals.invoiceCount;
  const avgTicket = totals.avgTicket;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6 lg:max-w-6xl xl:max-w-7xl">
      <AppNav role="OWNER" active="analytics"/>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("analyticsTitle")}</h1>
        <p className="text-sm text-text-mute">{t("analyticsSubtitle")}</p>
      </div>

      {/* Window selector — proper segmented control. All buttons live
          inside one rounded container; only the active button has the
          filled slate background. The seams between buttons (subtle
          dividers) read as 'these are mutually-exclusive options' at
          a glance. */}
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="tablist"
          aria-label={t("analyticsWindowSelector")}
          className="inline-flex w-fit items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
        >
          {[7, 14, 30, 90, 365].map((n) => {
            const isActive = n === days;
            return (
              <Link
                key={n}
                href={`/owner/analytics?days=${n}`}
                role="tab"
                aria-selected={isActive}
                className={
                  "inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-semibold tabular-nums transition-colors " +
                  (isActive
                    ? "bg-surface text-text shadow-sm dark:bg-brand-900 dark:text-white"
                    : "text-text-mute hover:bg-surface hover:text-text dark:hover:bg-brand-900/40")
                }
              >
                {n}d
              </Link>
            );
          })}
        </div>

        {/* CSV export — same window as the selected days. Server
            route matches the page's numbers exactly (shared aggregation
            in @/lib/analytics-daily). AR 2026-08-21 Batch 2. */}
        <a
          href={`/api/analytics/export?days=${days}`}
          className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm font-semibold text-text-mute hover:bg-surface-2 hover:text-text transition-colors"
        >
          ⤓ {t("analyticsCsvDownload")}
        </a>
        {/* Step 7 — per-part profit report (AR 2026-08-22). */}
        <Link
          href={`/owner/analytics/parts?days=${days}`}
          className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm font-semibold text-text-mute hover:bg-surface-2 hover:text-text transition-colors"
        >
          {t("partProfitLinkFromAnalytics")}
        </Link>
      </div>

      {/* Per-period profit — Step 6 (AR 2026-08-22). Sits ABOVE the
          ledger-based metric grid because Profit is the number the
          owner is here for; ticket/VAT/jobs are supporting data.
          Coverage is rendered at the same visual weight as Revenue
          and Profit per profit-reporting-spec.md §Coverage discipline. */}
      <PeriodProfitCard
        title={t("periodProfitTitle").replace("{days}", String(days))}
        profit={periodProfit}
        footnote={t("periodProfitFootnote")}
        labels={{
          revenue: t("periodProfitRevenue"),
          profit: t("periodProfitProfit"),
          coverage: t("periodProfitCoverage"),
          coverageOf: t("periodProfitCoverageOf"),
        }}
      />

      {/* Headline totals — same shape as the existing owner dashboard
          metric cards so the eye reads them as continuous data. */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label={t("analyticsRevenue")} value={money(revenueTotal)} />
        <Metric label={t("analyticsVat")} value={money(vatTotal)} />
        <Metric label={t("analyticsJobs")} value={String(jobsTotal)} />
        <Metric label={t("analyticsAvgTicket")} value={money(avgTicket)} />
      </div>

      {/* Charts — pure SVG, no chart lib. Each is a bar chart over
          the window. Y axis is implicit (max value highlighted in the
          label). Tooltip via <title> on each bar so hovering on
          desktop reveals the exact value + date.
          On lg+ they tile 2-up so the wide canvas isn't four narrow
          charts stacked vertically; below lg they stack as before. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2">
        <BarChart
          title={t("analyticsRevenuePerDay")}
          series={series.map((b) => ({ label: b.day, value: b.revenue }))}
          format={(v) => money(v)}
          color="emerald"
        />
        <BarChart
          title={t("analyticsVatPerDay")}
          series={series.map((b) => ({ label: b.day, value: b.vat }))}
          format={(v) => money(v)}
          color="amber"
        />
        <BarChart
          title={t("analyticsJobsPerDay")}
          series={series.map((b) => ({ label: b.day, value: b.jobs }))}
          format={(v) => String(v)}
          color="sky"
        />
        <BarChart
          title={t("analyticsAvgTicketPerDay")}
          series={series.map((b) => ({
            label: b.day,
            value: b.invoiceCount > 0 ? b.invoiceSum / b.invoiceCount : 0,
          }))}
          format={(v) => money(v)}
          color="fuchsia"
        />
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-surface p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-text-mute">
        {label}
      </div>
      <div className="mt-auto pt-2 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// Tailwind needs class names statically present in the source so the
// JIT can include them in the bundle. Use a lookup, not template
// interpolation.
const COLORS: Record<string, { bar: string; track: string }> = {
  emerald: { bar:"fill-emerald-500", track:"fill-emerald-500/10"},
  amber: { bar:"fill-amber-500", track:"fill-amber-500/10"},
  sky: { bar:"fill-sky-500", track:"fill-sky-500/10"},
  fuchsia: { bar:"fill-fuchsia-500", track:"fill-fuchsia-500/10"},
};

function BarChart({
  title,
  series,
  format,
  color,
}: {
  title: string;
  series: { label: string; value: number }[];
  format: (v: number) => string;
  color: keyof typeof COLORS;
}) {
  const W = 800;
  const H = 160;
  const PAD = 4;
  const max = Math.max(1, ...series.map((s) => s.value));
  const colW = (W - PAD * 2) / Math.max(1, series.length);
  const palette = COLORS[color];
  // Subtle y-axis reference lines at 50% and 100% of max. SVG-drawn
  // so they scale with the viewBox; styled via Tailwind tokens to
  // match the rest of the design system (border color + opacity).
  const yLines = [
    { yFrac: 0, label: "0" },
    { yFrac: 0.5, label: format(max / 2) },
    { yFrac: 1, label: format(max) },
  ];
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-xs text-text-mute tabular-nums">
          max {format(max)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-32 w-full"
        preserveAspectRatio="none"
      >
        {/* Y-axis reference lines — drawn first so the bars paint
            over them. 50% line is a subtle visual anchor; 100% is the
            ceiling so the eye can see where the tallest bar sits
            relative to max. */}
        {yLines.map((g) => {
          const y = PAD + (1 - g.yFrac) * (H - 2 * PAD);
          return (
            <line
              key={g.label}
              x1={PAD}
              x2={W - PAD}
              y1={y}
              y2={y}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray="2 3"
              opacity={g.yFrac === 0 ? 0.8 : 0.4}
            />
          );
        })}
        {series.map((s, i) => {
          const h = (s.value / max) * (H - 2 * PAD);
          const x = PAD + i * colW;
          const y = H - PAD - h;
          return (
            <g key={s.label}>
              {/* Track — faint background bar so empty days are still
                  visible (otherwise zero-value days disappear). */}
              <rect
                x={x + 1}
                y={PAD}
                width={Math.max(1, colW - 2)}
                height={H - 2 * PAD}
                className={palette.track}
              />
              <rect
                x={x + 1}
                y={y}
                width={Math.max(1, colW - 2)}
                height={Math.max(0, h)}
                className={palette.bar}
              >
                <title>{`${s.label} · ${format(s.value)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex justify-between text-[10px] tabular-nums text-text-mute">
        <span>{series[0]?.label ?? ""}</span>
        <span>{series[series.length - 1]?.label ?? ""}</span>
      </div>
    </div>
  );
}
