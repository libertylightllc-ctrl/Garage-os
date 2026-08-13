/**
 * Anthropic credit balance projection (Option B of the OCR credit-
 * alerting plan, AR 2026-08-14). Reads a manually-maintained cumulative
 * topup figure from `AI_CREDIT_TOTAL_TOPUP_USD` and subtracts the
 * running total of `AiEvent.costEstimate` to derive an estimated
 * remaining balance. Rolling 7-day daily average burn turns that
 * balance into a projected days-remaining number the cron endpoint
 * uses to gate the "top up soon" alert.
 *
 * Deliberate design choices (from the plan report):
 *
 *   - NO Anthropic Admin API dependency. AR reported wanting an option
 *     that works without a second API key or admin scope. The
 *     trade-off is drift: cost estimates are based on our per-token
 *     pricing table (`estimateCostUsd`), which excludes cache-read
 *     discounts, batch discounts, refunds, and any mid-month price
 *     changes. Off by ~5–15% in typical use. Alert threshold is set
 *     conservatively (7 days) so the drift doesn't burn AR.
 *
 *   - NO new schema table. `AI_CREDIT_TOTAL_TOPUP_USD` is a simple
 *     env var AR bumps when they top up. Yes, that means a Vercel
 *     env-var edit + redeploy per topup — but topups are monthly-ish,
 *     which is acceptable. An `AiCreditTopup` table is the follow-up
 *     when this friction bites.
 *
 *   - Cost source is `AiEvent.costEstimate` — the field already
 *     populated by every OCR / AI call site (safeLogAiEvent). No new
 *     instrumentation required, and historical burn is already there.
 */
import { prisma } from "@/lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AiCreditProjection {
    /** Cumulative topups since GarageOS started tracking, USD. */
    topupUsd: number;
    /** Sum of AiEvent.costEstimate across all garages, all time, USD. */
    spentUsd: number;
    /** topup - spent. May be negative if the env-var lags reality. */
    remainingUsd: number;
    /** Average USD/day over the last 7 days of AiEvent activity. */
    dailyBurnUsd: number;
    /**
     * remainingUsd / dailyBurnUsd, or Infinity if there's no measurable
     * burn (a fresh install with no traffic). Consumers should treat
     * Infinity as "not enough signal to alert" rather than "safe forever".
     */
    daysLeft: number;
    /**
     * When the topup env var is missing or unparseable. In that state
     * projection is meaningless — the cron endpoint skips alerting
     * and returns a diagnostic so a manual GET shows the reason.
     */
    topupConfigured: boolean;
}

/**
 * Compute the projection. Two DB round-trips: one for all-time spend,
 * one for the 7-day window. Both are indexed lookups against AiEvent.
 */
export async function computeAiCreditProjection(): Promise<AiCreditProjection> {
    const rawTopup = process.env.AI_CREDIT_TOTAL_TOPUP_USD;
    const topupUsd = rawTopup ? Number(rawTopup) : 0;
    const topupConfigured = rawTopup != null && Number.isFinite(topupUsd);

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

    // Two aggregations in parallel. Both use the AiEvent.costEstimate
    // column already populated by every AI/OCR call site.
    const [allTime, lastWeek] = await Promise.all([
        prisma.aiEvent.aggregate({
            _sum: { costEstimate: true },
        }),
        prisma.aiEvent.aggregate({
            _sum: { costEstimate: true },
            where: { createdAt: { gt: weekAgo } },
        }),
    ]);

    const spentUsd = Number(allTime._sum.costEstimate ?? 0);
    const weekSpend = Number(lastWeek._sum.costEstimate ?? 0);
    const dailyBurnUsd = weekSpend / 7;

    const remainingUsd = topupUsd - spentUsd;
    // Guard the divide: no traffic → Infinity signals "can't project".
    // Negative remaining shouldn't crash — pass through as 0 days.
    const daysLeft = (() => {
        if (dailyBurnUsd <= 0) return Number.POSITIVE_INFINITY;
        if (remainingUsd <= 0) return 0;
        return remainingUsd / dailyBurnUsd;
    })();

    return {
        topupUsd,
        spentUsd,
        remainingUsd,
        dailyBurnUsd,
        daysLeft,
        topupConfigured,
    };
}
