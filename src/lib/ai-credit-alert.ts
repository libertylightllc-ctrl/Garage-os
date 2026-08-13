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

interface AlertPayload {
    type: "AI_CREDIT_EXHAUSTED";
    at: string;
    garageId: string;
    model: string;
    side: "FRONT" | "BACK";
    apiMessage: string;
    hint: string;
}

function buildPayload(ctx: BillingAlertContext): AlertPayload {
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
