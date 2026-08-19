/**
 * Best-guess customer language for OUTBOUND-INITIATED sends
 * (reminders, initial estimates, initial invoices) — the paths that
 * fire without a fresh inbound message to detect from. AR 2026-08-19.
 *
 * Customer.lang is now NULLABLE (migration
 * 20260819180000_customer_lang_nullable) — null = "we don't know
 * yet". Previous @default(ar) manufactured "ar" for every prod row
 * and drove wrong-language sends. Rule 7 (production write paths
 * never fabricate): the record honestly says "unknown" until a real
 * signal arrives.
 *
 * NOT used by handleInbound — that path has the incoming message
 * body in hand and runs the detector directly. This helper only
 * matters when we're firing cold.
 */

import { prisma } from "@/lib/prisma";
import { detectLangFromBody } from "@/lib/lang-detect";
import type { Lang } from "@/lib/receptionist";

const SUPPORTED: Lang[] = ["ar", "en", "hi", "ur"];

function toSupported(v: string | null | undefined): Lang | null {
  if (!v) return null;
  return (SUPPORTED as string[]).includes(v) ? (v as Lang) : null;
}

/**
 * Resolve a language for an outbound WhatsApp message to `customerId`
 * within `garageId`. Preference order (each step falls through only
 * if the previous returned no confident answer):
 *   1. Detect from the customer's most recent inbound message body.
 *   2. Stored customer.lang, if the row has one.
 *   3. Garage.defaultLang, if the shop has one.
 *   4. Last resort: "en".
 *
 * The last-resort "en" is a communication choice, not a claim on
 * record — Customer.lang stays null until a real signal arrives.
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
  // No confident detection — fall back through stored customer.lang,
  // then garage.defaultLang, then "en". One combined query to avoid
  // a second round-trip.
  const cust = await prisma.customer.findFirst({
    where: { id: customerId, garageId },
    select: { lang: true, garage: { select: { defaultLang: true } } },
  });
  return (
    toSupported(cust?.lang) ??
    toSupported(cust?.garage?.defaultLang) ??
    "en"
  );
}
