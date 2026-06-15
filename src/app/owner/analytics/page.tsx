import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { companyGarageIds } from "@/lib/branches";
import { ACCOUNTS } from "@/lib/billing";
import { getT } from "@/i18n/server";

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

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const VALID_DAYS = new Set([7, 14, 30, 90, 365]);

export default async function OwnerAnalytics({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const gids = await companyGarageIds(session.user.garageId);
  const now = new Date();
  const { days: rawDays } = await searchParams;
  const days = (() => {
    const n = Number(rawDays);
    return Number.isFinite(n) && VALID_DAYS.has(n) ? n : 30;
  })();

  // Window: midnight UTC `days` ago through now. Aggregating per UTC
  // day keeps the math timezone-agnostic and consistent with how the
  // owner dashboard reads 'today'.
  const todayStart = startOfUtcDay(now);
  const fromD = new Date(todayStart.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  // Pull each datum in parallel. We could hand-roll one big query but
  // the explicit four-stream shape keeps every chart's data source
  // legible.
  const [salesLedger, vatLedger, jobsCreated, invoicesIssued] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: {
        garageId: { in: gids },
        account: ACCOUNTS.SALES,
        createdAt: { gte: fromD },
      },
      select: { createdAt: true, credit: true, debit: true },
    }),
    prisma.ledgerEntry.findMany({
      where: {
        garageId: { in: gids },
        account: ACCOUNTS.VAT_PAYABLE,
        createdAt: { gte: fromD },
      },
      select: { createdAt: true, credit: true, debit: true },
    }),
    prisma.jobCard.findMany({
      where: { garageId: { in: gids }, createdAt: { gte: fromD } },
      select: { createdAt: true },
    }),
    prisma.invoice.findMany({
      where: { garageId: { in: gids }, issuedAt: { gte: fromD } },
      select: { issuedAt: true, total: true },
    }),
  ]);

  // Bucket per UTC day. Pre-seed every day in the window so charts
  // render gaps as zeroes (a missing day on the right edge would
  // otherwise mislead the eye).
  type Bucket = { day: string; revenue: number; vat: number; jobs: number; invoiceSum: number; invoiceCount: number };
  const buckets = new Map<string, Bucket>();
  for (let i = 0; i < days; i++) {
    const d = new Date(fromD.getTime() + i * 24 * 60 * 60 * 1000);
    const key = ymd(d);
    buckets.set(key, { day: key, revenue: 0, vat: 0, jobs: 0, invoiceSum: 0, invoiceCount: 0 });
  }
  const bump = (d: Date, fn: (b: Bucket) => void) => {
    const b = buckets.get(ymd(d));
    if (b) fn(b);
  };
  for (const e of salesLedger) {
    // Credit-normal: revenue is credit minus debit.
    bump(e.createdAt, (b) => {
      b.revenue += Number(e.credit) - Number(e.debit);
    });
  }
  for (const e of vatLedger) {
    bump(e.createdAt, (b) => {
      b.vat += Number(e.credit) - Number(e.debit);
    });
  }
  for (const j of jobsCreated) {
    bump(j.createdAt, (b) => {
      b.jobs += 1;
    });
  }
  for (const inv of invoicesIssued) {
    bump(inv.issuedAt, (b) => {
      b.invoiceSum += Number(inv.total);
      b.invoiceCount += 1;
    });
  }
  const series = Array.from(buckets.values());

  // Headline totals — sum across the window. Avg ticket is total
  // invoice sum / count (across the window, not the daily mean of
  // daily means — that would be misleading on low-volume days).
  const revenueTotal = series.reduce((s, b) => s + b.revenue, 0);
  const vatTotal = series.reduce((s, b) => s + b.vat, 0);
  const jobsTotal = series.reduce((s, b) => s + b.jobs, 0);
  const invSumTotal = series.reduce((s, b) => s + b.invoiceSum, 0);
  const invCountTotal = series.reduce((s, b) => s + b.invoiceCount, 0);
  const avgTicket = invCountTotal > 0 ? invSumTotal / invCountTotal : 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
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
          desktop reveals the exact value + date. */}
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
                <title>
                  {s.label} · {format(s.value)}
                </title>
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
