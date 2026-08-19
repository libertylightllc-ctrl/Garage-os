import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { safeLogAiEvent } from "@/lib/ai-event-log";
import { recordInbound, sendWhatsApp, appUrl } from "@/lib/whatsapp";
import {
  classifyConversation,
  autoReply,
  holdingReply,
  handoffReply,
  draftFor,
  type Intent,
  type Lang,
} from "@/lib/receptionist";
import { ensurePublicToken } from "@/lib/document-tokens";
import { messages, statusKey } from "@/i18n/config";

import { detectLangFromBody } from "@/lib/lang-detect";

const SUPPORTED: Lang[] = ["ar", "en", "hi", "ur"];

/**
 * AR 2026-08-19 rewrite. The old shape only detected Hindi from
 * Devanagari and fell back to `customer.lang` for everything else —
 * which was "ar" for every prod customer (schema default; no code
 * path ever set another value; audit 2026-08-19). Result: an
 * English customer message got an Arabic auto-reply.
 *
 * Returns:
 *   - `{ lang, confident: true }` when the body signals a language.
 *   - `{ lang, confident: false }` when the detector can't tell —
 *     falls back to customer.lang (or "en" as last resort) and the
 *     caller MUST route to human approval before shipping any auto
 *     reply, per rule 4 (WhatsApp hand-off is not delivery — wrong-
 *     language mis-messages on wa.me can't be retracted).
 */
function resolveLang(customerLang: string | null | undefined, body: string): { lang: Lang; confident: boolean } {
  const detected = detectLangFromBody(body);
  if (detected !== null) return { lang: detected, confident: true };
  // Ambiguous body — no confident language signal in the message.
  // Fall back to the stored customer.lang if it's one we support;
  // otherwise last-resort "en". Customer.lang is nullable (AR
  // 2026-08-19) — null means "we don't know", handled the same as
  // an unrecognised value. Either way the caller routes to approval
  // instead of auto-firing.
  const stored = customerLang && (SUPPORTED as string[]).includes(customerLang)
    ? (customerLang as Lang)
    : "en";
  return { lang: stored, confident: false };
}

async function buildAutoReply(
  garageId: string,
  customerId: string,
  intent: Intent,
  lang: Lang,
): Promise<string> {
  if (intent === "STATUS") {
    const job = await prisma.jobCard.findFirst({
      where: { garageId, vehicle: { customerId } },
      orderBy: { updatedAt: "desc" },
      select: { status: true },
    });
    const statusLabel = job
      ? messages[lang === "ar" ? "ar" : "en"][statusKey(job.status)]
      : undefined;
    return autoReply("STATUS", lang, { statusLabel });
  }
  if (intent === "INVOICE") {
    const inv = await prisma.invoice.findFirst({
      where: { garageId, jobCard: { vehicle: { customerId } } },
      orderBy: { issuedAt: "desc" },
      // Phase 2 (2026-08-10): publicToken becomes the URL segment.
      select: { id: true, publicToken: true },
    });
    const link = inv
      ? `${appUrl()}/c/invoice/${await ensurePublicToken("invoice", inv)}`
      : undefined;
    return autoReply("INVOICE", lang, { link });
  }
  if (intent === "BOOKING") {
    return autoReply("BOOKING", lang, { bookLink: `${appUrl()}/c/book/${garageId}` });
  }
  return autoReply(intent, lang, {});
}

/**
 * Process one inbound WhatsApp message: idempotent record → (if BOT mode) classify and act:
 * AUTO replies directly, PROPOSE queues an advisor draft + sends a holding line, HANDOFF
 * flags the thread for a human. Every processed message is metered to AiEvent.
 */
export async function handleInbound(opts: {
  garageId: string;
  customer: { id: string; lang: string | null };
  waId: string;
  waMessageId: string;
  body: string;
}): Promise<void> {
  const rec = await recordInbound({
    garageId: opts.garageId,
    customerId: opts.customer.id,
    waId: opts.waId,
    waMessageId: opts.waMessageId,
    body: opts.body,
  });
  if (rec.dupe || rec.mode === "HUMAN") return; // dupe, or advisor already handling

  const { lang, confident: langConfident } = resolveLang(opts.customer.lang, opts.body);
  const cls = classifyConversation(opts.body);

  // Meter the AI interaction (the Layer-2 margin trap).
  // safeLogAiEvent — never throws. A crash here used to bubble out to
  // the WhatsApp webhook handler and trigger Meta retries; see
  // docs/telemetry-must-not-crash-operation-spec.md.
  await safeLogAiEvent({
    garageId: opts.garageId,
    kind: "RECEPTIONIST",
    model: "receptionist-rules",
    sourceType: "WHATSAPP",
    tokensIn: 0,
    tokensOut: 0,
    costEstimate: 0,
    latencyMs: 0,
  });

  const base = { garageId: opts.garageId, customerId: opts.customer.id, waId: opts.waId, aiGenerated: true };

  // AR 2026-08-19 — auto-send only when the language is confident.
  // Any auto-send from here (autoReply / holdingReply / handoffReply)
  // requires langConfident=true. When false, queue the same reply as
  // a draft for the advisor to review — the risk of firing in the
  // wrong language on wa.me (business-rules.md rule 4: not
  // retractable) outweighs a few seconds of advisor time.
  const queueDraft = async (body: string) => {
    await prisma.whatsAppMessage.create({
      data: {
        threadId: rec.threadId,
        direction: "OUT",
        body,
        waMessageId: `draft-${randomUUID()}`,
        status: "draft",
        aiGenerated: true,
        state: "PENDING_APPROVAL",
      },
    });
    await prisma.whatsAppThread.update({
      where: { id: rec.threadId },
      data: { threadStatus: "OPEN" },
    });
  };

  if (cls.route === "AUTO") {
    const reply = await buildAutoReply(opts.garageId, opts.customer.id, cls.intent, lang);
    if (langConfident) {
      await sendWhatsApp({ ...base, body: reply });
    } else {
      // Advisor decides both the wording and the language. Body is
      // seeded with the detector's best guess; advisor can rewrite
      // in the draft-card textarea before approving.
      await queueDraft(reply);
    }
  } else if (cls.route === "PROPOSE") {
    // Draft a reply for the advisor to approve.
    await queueDraft(draftFor(cls.intent, lang));
    // Holding line — "let me confirm with the team" — only fires
    // automatically when we're confident it'll go out in the right
    // language. Otherwise it queues alongside the substantive draft
    // (two cards for the advisor to approve or discard).
    if (langConfident) {
      await sendWhatsApp({ ...base, body: holdingReply(lang) });
    } else {
      await queueDraft(holdingReply(lang));
    }
  } else {
    // HANDOFF — mark thread as needing human attention. The
    // customer-facing acknowledgement fires auto only when
    // language-confident; otherwise the advisor picks the language.
    await prisma.whatsAppThread.update({
      where: { id: rec.threadId },
      data: { threadStatus: "NEEDS_HUMAN" },
    });
    if (langConfident) {
      await sendWhatsApp({ ...base, body: handoffReply(lang) });
    } else {
      await queueDraft(handoffReply(lang));
    }
  }
}
