/**
 * Reactive Anthropic-credit alert (Option A of the OCR credit-alerting
 * plan, AR 2026-08-14). Fires when the OCR pipeline logs its first
 * `billing`-category failure inside a 15-minute window — signals AR
 * out-of-band so the shop isn't blocked with only in-app breadcrumbs.
 *
 * Two notification channels, either or both may be active:
 *
 *   1. `ALERT_WEBHOOK_URL` env var — arbitrary HTTPS POST endpoint AR
 *      configures externally (Discord/Slack webhook, IFTTT, Zapier,
 *      an internal service). The body is JSON; the endpoint decides
 *      how to render it. Fire-and-forget: a delivery failure logs but
 *      never blocks or throws.
 *   2. `console.error` with the `[GARAGE_OS_ALERT]` prefix — Vercel
 *      Log Drains can forward these to any observability tool without
 *      new code. Zero-config path.
 *
 * Dedup uses the existing `AiEvent` table — no new schema. The
 * sourceType is written by intake-moulkia.ts as
 * `MOULKIA_<side>:billing:<msg>`; we count how many `:billing:` rows
 * appeared in the last 15 minutes *before* the row we just wrote. If
 * any, an alert was already fired for that earlier failure and we
 * skip. Trailing 5-second exclusion window keeps the current call's
 * own writes out of the count.
 *
 * Consequence of stateless dedup: two parallel intakes hitting billing
 * within ~5s of each other can each conclude they're the first, and
 * we send two webhooks. Acceptable for MVP — the alert is idempotent
 * from AR's POV ("credit is out, go top up") and a duplicate ping is
 * far less bad than a suppressed one. Upgrade path is a real
 * `AlertSent` table or a Vercel KV lock; deferred until it bites.
 */
import { prisma } from "@/lib/prisma";

const ALERT_WINDOW_MS = 15 * 60_000;
// Skip AiEvent rows written in the last N ms so we don't dedup against
// the ones this very call just wrote.
const RECENT_EXCLUSION_MS = 5_000;

export interface BillingAlertContext {
    garageId: string;
    /** The model whose call failed (Sonnet / Haiku / …). */
    model: string;
    /** Full API error message — trimmed before send. */
    apiMessage: string;
    /** "FRONT" | "BACK" — which side of the Moulkia OCR failed. */
    side: "FRONT" | "BACK";
}

/**
 * Query AiEvent for prior billing failures inside the alert window,
 * excluding rows written in the last ~5 seconds (the just-committed
 * rows from this same intake POST). Returns true iff this is the
 * first billing failure in the window and we should send.
 */
async function isFirstInWindow(): Promise<boolean> {
    const now = Date.now();
    const priorBilling = await prisma.aiEvent.count({
        where: {
            kind: "OCR",
            createdAt: {
                gt: new Date(now - ALERT_WINDOW_MS),
                lt: new Date(now - RECENT_EXCLUSION_MS),
            },
            sourceType: { contains: ":billing:" },
        },
    });
    return priorBilling === 0;
}

interface ExhaustedPayload {
    type: "AI_CREDIT_EXHAUSTED";
    at: string;
    garageId: string;
    model: string;
    side: "FRONT" | "BACK";
    apiMessage: string;
    hint: string;
}

interface LowBalancePayload {
    type: "AI_CREDIT_LOW";
    at: string;
    topupUsd: number;
    spentUsd: number;
    remainingUsd: number;
    dailyBurnUsd: number;
    daysLeft: number;
    hint: string;
}

interface StaleTopupPayload {
    type: "AI_CREDIT_TOPUP_STALE";
    at: string;
    topupUsd: number;
    spentUsd: number;
    /** Always negative when this alert fires — that's the whole trigger. */
    remainingUsd: number;
    hint: string;
}

type AlertPayload = ExhaustedPayload | LowBalancePayload | StaleTopupPayload;

function buildPayload(ctx: BillingAlertContext): ExhaustedPayload {
    // Trim the API message — Anthropic error strings can carry ~500
    // chars of guidance; the webhook consumer doesn't need all of it.
    const msg = ctx.apiMessage.slice(0, 300);
    return {
        type: "AI_CREDIT_EXHAUSTED",
        at: new Date().toISOString(),
        garageId: ctx.garageId,
        model: ctx.model,
        side: ctx.side,
        apiMessage: msg,
        hint: "Anthropic account credits look exhausted. Top up and OCR will resume automatically.",
    };
}

async function postWebhook(payload: AlertPayload): Promise<void> {
    const url = process.env.ALERT_WEBHOOK_URL;
    if (!url) return;
    // 3-second timeout keeps a slow webhook endpoint from stalling the
    // advisor's redirect. Fire-and-forget is enough — this is a
    // best-effort side-channel notification, not a durable message.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3_000);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
        });
        if (!res.ok) {
            console.error(
                `[GARAGE_OS_ALERT] webhook non-2xx: ${res.status} ${res.statusText}`,
            );
        }
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.error(`[GARAGE_OS_ALERT] webhook error: ${m}`);
    } finally {
        clearTimeout(t);
    }
}

/**
 * Send a credit-exhausted alert, dedup-gated. Never throws — the
 * caller is a server action mid-redirect and must not fail on
 * notification plumbing (same rationale as safeLogAiEvent).
 *
 * Call sites: `intake-moulkia.ts` → `logAttempts` after writing
 * AiEvents, iff any attempt.errorCategory === "billing".
 */
export async function sendBillingAlertIfNeeded(
    ctx: BillingAlertContext,
): Promise<void> {
    try {
        const first = await isFirstInWindow();
        if (!first) return;
        const payload = buildPayload(ctx);
        // Structured log line — Vercel Log Drains can forward these
        // without any additional config. Grep-friendly prefix.
        console.error(
            `[GARAGE_OS_ALERT] AI_CREDIT_EXHAUSTED garage=${ctx.garageId} model=${ctx.model} side=${ctx.side} msg=${payload.apiMessage}`,
        );
        await postWebhook(payload);
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.error(`[GARAGE_OS_ALERT] sendBillingAlertIfNeeded threw: ${m}`);
    }
}

/**
 * Option B — proactive low-balance alert. Called from the nightly
 * cron endpoint after computing the projection. NO dedup here: the
 * cron runs once daily by construction, so at most one alert per day
 * per environment, which is the right cadence for "you should top up
 * this week" reminders. Same two channels as the reactive alert
 * (console.error prefix + optional webhook), same never-throws
 * contract, same JSON payload shape modulo `type`.
 */
/**
 * Fires when computed `remainingUsd` goes negative — a hard signal
 * that `AI_CREDIT_TOTAL_TOPUP_USD` is stale. The cron uses this
 * INSTEAD of the low-balance alert in that case; a stale figure
 * makes daysLeft meaningless, so pinging "you have 0 days left"
 * every night is worse than useless. Same never-throws contract.
 *
 * No dedup at helper level — cron fires once per day by construction,
 * and while the figure remains stale a daily nag is exactly the right
 * cadence (get AR to update the env var).
 */
export async function sendStaleTopupAlert(context: {
    topupUsd: number;
    spentUsd: number;
    remainingUsd: number;
}): Promise<void> {
    try {
        const payload: StaleTopupPayload = {
            type: "AI_CREDIT_TOPUP_STALE",
            at: new Date().toISOString(),
            topupUsd: context.topupUsd,
            spentUsd: context.spentUsd,
            remainingUsd: context.remainingUsd,
            hint: `AI_CREDIT_TOTAL_TOPUP_USD ($${context.topupUsd.toFixed(2)}) is less than measured spend ($${context.spentUsd.toFixed(2)}). Either a top-up wasn't recorded, or the env var lags behind reality. Update it (Vercel env → redeploy) to restore the daysLeft projection.`,
        };
        console.error(
            `[GARAGE_OS_ALERT] AI_CREDIT_TOPUP_STALE topupUsd=${payload.topupUsd.toFixed(2)} spentUsd=${payload.spentUsd.toFixed(2)} remainingUsd=${payload.remainingUsd.toFixed(2)}`,
        );
        await postWebhook(payload);
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.error(`[GARAGE_OS_ALERT] sendStaleTopupAlert threw: ${m}`);
    }
}

export async function sendLowBalanceAlert(projection: {
    topupUsd: number;
    spentUsd: number;
    remainingUsd: number;
    dailyBurnUsd: number;
    daysLeft: number;
}): Promise<void> {
    try {
        const payload: LowBalancePayload = {
            type: "AI_CREDIT_LOW",
            at: new Date().toISOString(),
            topupUsd: projection.topupUsd,
            spentUsd: projection.spentUsd,
            remainingUsd: projection.remainingUsd,
            dailyBurnUsd: projection.dailyBurnUsd,
            daysLeft: projection.daysLeft,
            hint: `Estimated ${projection.daysLeft.toFixed(1)} days of Anthropic credit left at current burn (~$${projection.dailyBurnUsd.toFixed(2)}/day). Top up before OCR starts refusing intakes.`,
        };
        console.error(
            `[GARAGE_OS_ALERT] AI_CREDIT_LOW daysLeft=${payload.daysLeft.toFixed(1)} remainingUsd=${payload.remainingUsd.toFixed(2)} dailyBurnUsd=${payload.dailyBurnUsd.toFixed(2)}`,
        );
        await postWebhook(payload);
    } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.error(`[GARAGE_OS_ALERT] sendLowBalanceAlert threw: ${m}`);
    }
}
