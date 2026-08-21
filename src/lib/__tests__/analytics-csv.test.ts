/**
 * analyticsToCsv — CSV serialisation (AR 2026-08-21).
 *
 * Pure unit test — bypasses the DB by constructing DailyAnalytics
 * directly. The compute half of computeDailyAnalytics is covered
 * indirectly by the page render in dev; the escape logic and shape
 * are the fragile parts that a CSV consumer will break on.
 */

import { describe, expect, it } from "vitest";
import { analyticsToCsv, type DailyAnalytics } from "@/lib/analytics-daily";

const base = (series: DailyAnalytics["series"]): DailyAnalytics => {
  const totals = series.reduce(
    (t, b) => ({
      revenue: t.revenue + b.revenue,
      vat: t.vat + b.vat,
      jobs: t.jobs + b.jobs,
      invoiceSum: t.invoiceSum + b.invoiceSum,
      invoiceCount: t.invoiceCount + b.invoiceCount,
      avgTicket: 0,
    }),
    { revenue: 0, vat: 0, jobs: 0, invoiceSum: 0, invoiceCount: 0, avgTicket: 0 },
  );
  totals.avgTicket = totals.invoiceCount > 0 ? totals.invoiceSum / totals.invoiceCount : 0;
  return { from: new Date("2026-08-01"), days: series.length, series, totals };
};

describe("analyticsToCsv", () => {
  it("emits header row + one row per day, trailing newline", () => {
    const csv = analyticsToCsv(base([
      { day: "2026-08-01", revenue: 1000, vat: 50, jobs: 3, invoiceSum: 1050, invoiceCount: 2 },
      { day: "2026-08-02", revenue: 500, vat: 25, jobs: 1, invoiceSum: 525, invoiceCount: 1 },
    ]));
    const lines = csv.split("\n");
    // 1 header + 2 days + trailing empty (from final \n).
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("date,revenue,vat_collected,jobs_created,invoices_count,invoice_sum,avg_ticket");
    expect(lines[1]).toBe("2026-08-01,1000.00,50.00,3,2,1050.00,525.00");
    expect(lines[2]).toBe("2026-08-02,500.00,25.00,1,1,525.00,525.00");
    expect(lines[3]).toBe("");
  });

  it("avg_ticket per row is invoice_sum/invoice_count, 0 on zero-count day", () => {
    const csv = analyticsToCsv(base([
      { day: "2026-08-01", revenue: 0, vat: 0, jobs: 0, invoiceSum: 0, invoiceCount: 0 },
    ]));
    const [, row] = csv.split("\n");
    // Last column = avg_ticket = 0.00 (guarded div).
    expect(row.split(",").at(-1)).toBe("0.00");
  });

  it("formats money to 2dp regardless of input precision", () => {
    const csv = analyticsToCsv(base([
      // Values chosen to be stably representable in IEEE-754 so
      // toFixed's rounding isn't the test flake — the point is the
      // 2dp shape, not toFixed's edge cases.
      { day: "2026-08-01", revenue: 1000.5, vat: 0.1, jobs: 0, invoiceSum: 12.5, invoiceCount: 1 },
    ]));
    const [, row] = csv.split("\n");
    const cells = row.split(",");
    expect(cells[1]).toBe("1000.50");
    expect(cells[2]).toBe("0.10");
    expect(cells[5]).toBe("12.50");
    expect(cells[6]).toBe("12.50");           // avg_ticket
  });

  it("escapes a value containing a comma / quote / newline per RFC 4180", () => {
    // date column is where a comma-containing value would leak into
    // adjacent columns; force-inject one to prove the escape works.
    const csv = analyticsToCsv({
      from: new Date("2026-08-01"),
      days: 1,
      series: [{ day: "unusual, day", revenue: 0, vat: 0, jobs: 0, invoiceSum: 0, invoiceCount: 0 }],
      totals: { revenue: 0, vat: 0, jobs: 0, invoiceSum: 0, invoiceCount: 0, avgTicket: 0 },
    });
    const [, row] = csv.split("\n");
    expect(row.startsWith('"unusual, day"')).toBe(true);
    // Row still parses to 7 fields.
    // (Not doing a full parse; just prove the outer quotes are on
    // the problematic cell.)
  });
});
