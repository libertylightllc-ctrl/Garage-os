/**
 * Nightly auto-close for stale work sessions (AR 2026-08-20 Finding 2).
 *
 * The tech-tracking flow closes sessions on switch / mark-complete /
 * send-for-estimate / cancel / hold, and 2026-08-20 added closes at
 * the two ON_HOLD leak sites (parts request + extra-work approval).
 * None of those reach the case where a tech just walks away — closes
 * their tab, drives home. Their session stays open, and the NEXT
 * morning's tap on another car auto-closes it as SWITCHED with a
 * ~16-hour duration. That inflated duration then flowed straight
 * into the profit card as "labour cost" (INV-2026-0051: 200
 * revenue / 444.91 cost, -122.5% margin — the trigger for this
 * whole batch).
 *
 * Schedule: 02:00 Gulf (Asia/Dubai) = 22:00 UTC. After the working
 * day ends, before the next starts. A session open at 6pm gets
 * closed overnight rather than surviving into the morning's tap.
 * See vercel.json.
 *
 * Threshold: 12h. A session running longer than that is not real
 * shift time — the shop was closed for at least some of it. AR's
 * choice matches the "flag rather than cap or rewrite" policy: the
 * raw startedAt is preserved untouched, endedAt gets stamped at
 * now(), and laborCostSnapshot is set to NULL. The profit card
 * treats a null snapshot as Unknown — never as "zero cost / 100%
 * margin" and never as an invented 12-hour cost figure. We don't
 * know how long the tech actually worked; saying so beats
 * fabricating a number.
 *
 * Also — reports per-session detail (tech name, job number,
 * duration hours) in the JSON response and stderr log. Silent
 * cleanup hides the technician-not-stopping-the-clock behaviour
 * this compensates for; the log makes the pattern visible.
 *
 * Auth: mirrors /api/cron/ai-credit-check. If CRON_SECRET is set
 * (Vercel provisions this automatically for cron paths), require
 * the matching Bearer. If unset, allow unauthenticated GETs so ops
 * can hit the endpoint during initial setup.
 */

import { NextResponse } from "next/server";
import { autoCloseStaleSessions } from "@/lib/work-session";

// ─── Do NOT align this with SUSPICIOUS_SESSION_MS (8h) ───
// The profit / Hours suspicious threshold is 8h; this destructive-
// close threshold is 12h. Deliberately different (AR 2026-08-21):
// the bar for closing a row (DB write, stamps NULL cost, cannot be
// undone without an operator) is higher than the bar for excluding
// it from a report (reversible judgement, session data untouched).
// Aligning either direction trades the wrong risk for the wrong
// safety. See the fuller note on SUSPICIOUS_SESSION_MS in
// src/lib/job-profit.ts.
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export async function GET(req: Request): Promise<Response> {
  // Unconditional startup log so a Vercel function log line ALWAYS
  // exists per invocation, regardless of auth outcome. Added
  // 2026-08-20 after a manual Vercel Run appeared to do nothing —
  // there was no log line either way, so we couldn't tell if the
  // route was 401'd, executed with zero candidates, or errored.
  const secret = process.env.CRON_SECRET;
  const authRequired = Boolean(secret);
  const authHeader = req.headers.get("authorization") ?? "";
  const authOk = !secret || authHeader === `Bearer ${secret}`;
  console.log(
    `[auto-close-stale-sessions] invoked at=${new Date().toISOString()} authRequired=${authRequired} authOk=${authOk} thresholdHours=12`,
  );

  if (secret && !authOk) {
    // Log the mismatch shape (not the secret) so ops can spot
    // "Vercel dashboard Run" vs "cron scheduler" vs "external curl"
    // by header pattern. authHeader.startsWith("Bearer ") tells us
    // whether ANY bearer was sent, without leaking either token.
    console.warn(
      `[auto-close-stale-sessions] 401 — no matching Authorization; bearer sent=${authHeader.startsWith("Bearer ")}`,
    );
    return new NextResponse("unauthorized", { status: 401 });
  }

  const closed = await autoCloseStaleSessions(TWELVE_HOURS_MS);

  // Log the summary + per-session detail to stderr — Vercel captures
  // stderr into the function log where ops can grep for patterns
  // (e.g. `AUTO_CLOSED tech="Ahmed"` over the past 7 days). Kept as
  // a single line per session for grep-friendliness.
  if (closed.length === 0) {
    console.log(`[auto-close-stale-sessions] closed=0 (nothing to close)`);
  } else {
    console.log(
      `[auto-close-stale-sessions] closed=${closed.length} thresholdHours=12`,
    );
    for (const s of closed) {
      console.log(
        `[auto-close-stale-sessions] session=${s.id} tech=${JSON.stringify(s.techName ?? s.techId)} jobCard=${s.jobCardNumber ?? "?"} startedAt=${s.startedAt.toISOString()} durationHours=${s.durationHours}`,
      );
    }
  }

  return NextResponse.json({
    thresholdHours: 12,
    closedCount: closed.length,
    closed,
  });
}
