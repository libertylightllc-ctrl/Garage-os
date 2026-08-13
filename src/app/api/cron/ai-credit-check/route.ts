/**
 * Option B — nightly Anthropic-credit projection endpoint (AR 2026-08-14).
 *
 * Runs from Vercel cron (see vercel.json). Reads `AI_CREDIT_TOTAL_TOPUP_USD`
 * (cumulative topups AR has made) and subtracts running spend from
 * `AiEvent.costEstimate` to derive a rough remaining balance. If the
 * projected days-remaining at current 7-day burn drops below
 * `AI_CREDIT_ALERT_DAYS_THRESHOLD` (default 7), fires the
 * AI_CREDIT_LOW alert (log line + optional webhook).
 *
 * Auth: Vercel-cron requests carry `Authorization: Bearer <CRON_SECRET>`.
 * When `CRON_SECRET` is set, we require it; when it isn't, we accept
 * unauthenticated GETs so ops can hit the endpoint manually during
 * setup. Never returns raw balance to unauthenticated callers when
 * the secret IS configured — same posture as /api/diagnose/db.
 *
 * Response is always JSON (metrics + a reason string), so a manual GET
 * during setup shows exactly what the cron sees. The "alerted" boolean
 * makes it easy to verify the alert plumbing end-to-end without
 * waiting for the schedule.
 */
import { NextResponse } from "next/server";
import { computeAiCreditProjection } from "@/lib/ai-credit-balance";
import { sendLowBalanceAlert } from "@/lib/ai-credit-alert";

const DEFAULT_ALERT_DAYS = 7;

export async function GET(req: Request): Promise<Response> {
    // Auth check: if CRON_SECRET is set (Vercel sets this automatically
    // when a cron is configured), require the matching bearer token.
    // If CRON_SECRET isn't set, allow unauthenticated GETs so this
    // endpoint stays usable during initial setup / debugging.
    const secret = process.env.CRON_SECRET;
    if (secret) {
        const auth = req.headers.get("authorization") ?? "";
        if (auth !== `Bearer ${secret}`) {
            return new NextResponse("unauthorized", { status: 401 });
        }
    }

    const projection = await computeAiCreditProjection();

    // Threshold override lets AR tune "how many days is 'low'" without
    // a code change. Default 7 days — one week of runway before the
    // credit runs out at current burn.
    const rawThreshold = process.env.AI_CREDIT_ALERT_DAYS_THRESHOLD;
    const threshold = rawThreshold
        ? Number(rawThreshold)
        : DEFAULT_ALERT_DAYS;
    const thresholdValid = Number.isFinite(threshold) && threshold > 0;

    // Decide alert vs skip. Reason string is returned in the response
    // so a manual GET tells ops exactly why an alert did or didn't
    // fire — same shape as the projection field for easy JSON parsing.
    let alerted = false;
    let reason: string;
    if (!projection.topupConfigured) {
        reason =
            "AI_CREDIT_TOTAL_TOPUP_USD is not set — projection meaningless, alert skipped.";
    } else if (!thresholdValid) {
        reason = `AI_CREDIT_ALERT_DAYS_THRESHOLD is invalid ("${rawThreshold}") — alert skipped.`;
    } else if (!Number.isFinite(projection.daysLeft)) {
        reason =
            "No AiEvent activity in the last 7 days — daily burn is zero, projection meaningless, alert skipped.";
    } else if (projection.daysLeft < threshold) {
        await sendLowBalanceAlert(projection);
        alerted = true;
        reason = `daysLeft (${projection.daysLeft.toFixed(1)}) < threshold (${threshold}) — alert sent.`;
    } else {
        reason = `daysLeft (${projection.daysLeft.toFixed(1)}) >= threshold (${threshold}) — no alert needed.`;
    }

    return NextResponse.json({
        ok: true,
        alerted,
        reason,
        threshold,
        projection,
    });
}
