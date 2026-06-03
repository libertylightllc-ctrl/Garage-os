import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { recordInbound, sendWhatsApp, appUrl } from "@/lib/whatsapp";
import {
  classifyConversation,
  autoReply,
  holdingReply,
  handoffReply,
  draftFor,
  type Intent,
} from "@/lib/receptionist";
import { signId } from "@/lib/tokens";
import { messages, statusKey } from "@/i18n/config";

type Lang = "ar" | "en";

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
    const statusLabel = job ? messages[lang][statusKey(job.status)] : undefined;
    return autoReply("STATUS", lang, { statusLabel });
  }
  if (intent === "INVOICE") {
    const inv = await prisma.invoice.findFirst({
      where: { garageId, jobCard: { vehicle: { customerId } } },
      orderBy: { issuedAt: "desc" },
      select: { id: true },
    });
    const link = inv ? `${appUrl()}/c/invoice/${signId("invoice", inv.id)}` : undefined;
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
  customer: { id: string; lang: string };
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

  const lang: Lang = opts.customer.lang === "ar" ? "ar" : "en";
  const cls = classifyConversation(opts.body);

  // Meter the AI interaction (the Layer-2 margin trap).
  await prisma.aiEvent.create({
    data: {
      garageId: opts.garageId,
      kind: "RECEPTIONIST",
      model: "receptionist-rules",
      sourceType: "WHATSAPP",
      tokensIn: 0,
      tokensOut: 0,
      costEstimate: 0,
      latencyMs: 0,
    },
  });

  const base = { garageId: opts.garageId, customerId: opts.customer.id, waId: opts.waId, aiGenerated: true };

  if (cls.route === "AUTO") {
    const reply = await buildAutoReply(opts.garageId, opts.customer.id, cls.intent, lang);
    await sendWhatsApp({ ...base, body: reply });
  } else if (cls.route === "PROPOSE") {
    // Draft a reply for the advisor to approve; tell the customer we're confirming.
    await prisma.whatsAppMessage.create({
      data: {
        threadId: rec.threadId,
        direction: "OUT",
        body: draftFor(cls.intent, lang),
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
    await sendWhatsApp({ ...base, body: holdingReply(lang) });
  } else {
    // HANDOFF
    await prisma.whatsAppThread.update({
      where: { id: rec.threadId },
      data: { threadStatus: "NEEDS_HUMAN" },
    });
    await sendWhatsApp({ ...base, body: handoffReply(lang) });
  }
}
