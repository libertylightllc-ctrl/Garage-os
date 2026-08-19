/**
 * Best-guess customer language for OUTBOUND-INITIATED sends
 * (reminders, initial estimates, initial invoices) — the paths that
 * fire without a fresh inbound message to detect from. AR 2026-08-19.
 *
 * Every prod customer.lang is "ar" (schema default; audit 2026-08-19).
 * Reading it blindly ships every reminder / estimate / invoice in
 * Arabic to English + Hindi + Urdu speakers alike. This helper looks
 * at the customer's most recent inbound WhatsApp message and runs
 * the detector on it; the detector is much more likely to be right
 * than the stored default. Fall back to stored customer.lang only
 * when there's no inbound to detect from (brand-new customer).
 *
 * One extra query per send. Small; the alternative is a
 * customer.lang backfill migration + a stateful re-detect on every
 * inbound, which is a separate change.
 *
 * NOT used by handleInbound — that path has the incoming message
 * body in hand and runs the detector directly. This helper only
 * matters when we're firing cold.
 */

import { prisma } from "@/lib/prisma";
import { detectLangFromBody } from "@/lib/lang-detect";
import type { Lang } from "@/lib/receptionist";

const SUPPORTED: Lang[] = ["ar", "en", "hi", "ur"];

/**
 * Resolve a language for an outbound WhatsApp message to `customerId`
 * within `garageId`. Preference order:
 *   1. Detect from the customer's most recent inbound message body,
 *      if any inbound exists AND the detector returns non-null.
 *   2. Fall back to the stored customer.lang, gated to SUPPORTED.
 *   3. Last resort: "en".
 *
 * Kept garage-scoped to defeat any cross-tenant leak on a bad id.
 */
export async function resolveCustomerLangForOutbound(
  customerId: string,
  garageId: string,
): Promise<Lang> {
  // Latest inbound WhatsApp message body for this customer. LIMIT 1,
  // ordered by createdAt desc via the thread relation. Nothing back →
  // fall through to the stored lang.
  const latest = await prisma.whatsAppMessage.findFirst({
    where: {
      direction: "IN",
      body: { not: null },
      thread: { garageId, customerId },
    },
    orderBy: { createdAt: "desc" },
    select: { body: true },
  });
  if (latest?.body) {
    const detected = detectLangFromBody(latest.body);
    if (detected !== null) return detected;
  }
  // No confident detection — fall back to the stored customer.lang.
  // Re-read from DB rather than trust a caller-supplied value; the
  // helper is the single point where "what language should we send
  // in" is resolved for cold-start outbound.
  const cust = await prisma.customer.findFirst({
    where: { id: customerId, garageId },
    select: { lang: true },
  });
  const stored = cust?.lang ?? "en";
  return (SUPPORTED as string[]).includes(stored) ? (stored as Lang) : "en";
}
