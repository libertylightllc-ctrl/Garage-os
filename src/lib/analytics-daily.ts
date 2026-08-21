import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";

/**
 * Owner analytics — daily series compute (AR 2026-08-21 extraction).
 *
 * Extracted from src/app/owner/analytics/page.tsx so the CSV export
 * route hits the exact same aggregation. Page renders the series as
 * inline SVG charts; the export route writes the same rows as CSV.
 * Numbers on screen and in the downloaded file agree by construction.
 *
 * Aggregation:
 *   - revenue per day (credit − debit on ACCOUNTS.SALES ledger)
 *   - vat per day (credit − debit on ACCOUNTS.VAT_PAYABLE ledger)
 *   - jobs created per day (JobCard.createdAt count)
 *   - invoice sum + count per day (Invoice.issuedAt / total)
 *
 * Bucketing is per UTC day. Pre-seeds every day in the window so
 * gaps render as zero, not as "missing" — matches how the charts
 * on the page look.
 */

export interface DailyBucket {
  day: string;   // YYYY-MM-DD (UTC)
  revenue: number;
  vat: number;
  jobs: number;
  invoiceSum: number;
  invoiceCount: number;
}

export interface DailyTotals {
  revenue: number;
  vat: number;
  jobs: number;
  invoiceSum: number;
  invoiceCount: number;
  avgTicket: number;
}

export interface DailyAnalytics {
  from: Date;
  days: number;
  series: DailyBucket[];
  totals: DailyTotals;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function computeDailyAnalytics(
  gids: string[],
  days: number,
  now: Date = new Date(),
): Promise<DailyAnalytics> {
  const todayStart = startOfUtcDay(now);
  const from = new Date(todayStart.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  const [salesLedger, vatLedger, jobsCreated, invoicesIssued] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { garageId: { in: gids }, account: ACCOUNTS.SALES, createdAt: { gte: from } },
      select: { createdAt: true, credit: true, debit: true },
    }),
    prisma.ledgerEntry.findMany({
      where: { garageId: { in: gids }, account: ACCOUNTS.VAT_PAYABLE, createdAt: { gte: from } },
      select: { createdAt: true, credit: true, debit: true },
    }),
    prisma.jobCard.findMany({
      where: { garageId: { in: gids }, createdAt: { gte: from } },
      select: { createdAt: true },
    }),
    prisma.invoice.findMany({
      where: { garageId: { in: gids }, issuedAt: { gte: from } },
      select: { issuedAt: true, total: true },
    }),
  ]);

  const buckets = new Map<string, DailyBucket>();
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const key = ymd(d);
    buckets.set(key, { day: key, revenue: 0, vat: 0, jobs: 0, invoiceSum: 0, invoiceCount: 0 });
  }
  const bump = (d: Date, fn: (b: DailyBucket) => void) => {
    const b = buckets.get(ymd(d));
    if (b) fn(b);
  };
  for (const e of salesLedger) {
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
    bump(j.createdAt, (b) => { b.jobs += 1; });
  }
  for (const inv of invoicesIssued) {
    bump(inv.issuedAt, (b) => {
      b.invoiceSum += Number(inv.total);
      b.invoiceCount += 1;
    });
  }
  const series = Array.from(buckets.values());
  const revenue = series.reduce((s, b) => s + b.revenue, 0);
  const vat = series.reduce((s, b) => s + b.vat, 0);
  const jobs = series.reduce((s, b) => s + b.jobs, 0);
  const invoiceSum = series.reduce((s, b) => s + b.invoiceSum, 0);
  const invoiceCount = series.reduce((s, b) => s + b.invoiceCount, 0);
  const totals: DailyTotals = {
    revenue, vat, jobs, invoiceSum, invoiceCount,
    avgTicket: invoiceCount > 0 ? invoiceSum / invoiceCount : 0,
  };
  return { from, days, series, totals };
}

/**
 * Serialise a DailyAnalytics into CSV text. Escapes the standard
 * three CSV special chars (comma, double-quote, newline) per RFC
 * 4180: any cell containing them is wrapped in double-quotes; a
 * double-quote inside becomes "". Header row first.
 */
export function analyticsToCsv(a: DailyAnalytics): string {
  const header = ["date", "revenue", "vat_collected", "jobs_created", "invoices_count", "invoice_sum", "avg_ticket"];
  const rows: string[][] = [header];
  for (const b of a.series) {
    const avg = b.invoiceCount > 0 ? b.invoiceSum / b.invoiceCount : 0;
    rows.push([
      b.day,
      b.revenue.toFixed(2),
      b.vat.toFixed(2),
      String(b.jobs),
      String(b.invoiceCount),
      b.invoiceSum.toFixed(2),
      avg.toFixed(2),
    ]);
  }
  return rows.map(escapeRow).join("\n") + "\n";
}

function escapeRow(cells: string[]): string {
  return cells.map(escapeCell).join(",");
}

function escapeCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
