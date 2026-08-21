/**
 * Owner analytics — CSV export (AR 2026-08-21 Batch 2).
 *
 * Same aggregation as /owner/analytics via
 * src/lib/analytics-daily.ts. Query param `?days=` matches the page
 * (7 / 14 / 30 / 90 / 365; anything else falls back to 30). Returns
 * text/csv with a download-friendly filename.
 *
 * Guard: OWNER only, matching the page. MASTER + others get 403.
 */

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { companyGarageIds } from "@/lib/branches";
import { analyticsToCsv, computeDailyAnalytics } from "@/lib/analytics-daily";

const VALID_DAYS = new Set([7, 14, 30, 90, 365]);

export async function GET(req: Request): Promise<Response> {
  let session;
  try {
    session = await requireRole("OWNER");
  } catch {
    return new NextResponse("forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const rawDays = url.searchParams.get("days");
  const days = (() => {
    const n = Number(rawDays);
    return Number.isFinite(n) && VALID_DAYS.has(n) ? n : 30;
  })();

  const gids = await companyGarageIds(session.user.garageId);
  const analytics = await computeDailyAnalytics(gids, days);
  const csv = analyticsToCsv(analytics);
  const today = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="analytics-${today}-${days}d.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
