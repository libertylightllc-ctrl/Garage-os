import { prisma } from "@/lib/prisma";
import { handleInbound } from "@/lib/receptionist-engine";
import { normalizeUaePhone, normalizeCustomerPhoneForWrite } from "@/lib/normalize";

// Meta webhook verification handshake.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

interface WaMessage {
  from: string;
  id: string;
  text?: { body?: string };
}
interface WaChange {
  value?: { metadata?: { phone_number_id?: string }; messages?: WaMessage[] };
}

// Inbound — routes to the garage that owns the receiving number (multi-tenant), then
// hands each message to the AI engine. Always 200 so Meta stops retrying.
export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as { entry?: { changes?: WaChange[] }[] };
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const acct = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId } });
        if (!acct) continue; // unknown number — not ours
        const garageId = acct.garageId;

        for (const m of change.value?.messages ?? []) {
          // Meta passes waId as the E.164 without a leading '+' (per
          // Cloud API webhook contract, e.g. "971501234567"). Match
          // against both shapes — normalized (waId column, if the
          // customer has previously chatted from this number) OR
          // the phone column (which we now normalize on write). AR
          // 2026-08-21 — was upserting on the raw waId even when the
          // same customer's Customer row was keyed on a differently-
          // formatted phone from the public booking or Moulkia
          // intake, producing duplicate rows. normalizeUaePhone
          // reduces every UAE-shaped format to the same 9-digit key.
          const waIdRaw = m.from;
          // Legacy 9-digit shape kept as a lookup key ONLY — bridges
          // customers stored before AR 2026-08-23 (when writes went
          // through `normalizeUaePhone`). The 9-digit clause below
          // becomes dead once step-4 backfill migrates legacy rows to
          // E.164; leaving it in until then keeps the webhook idempotent
          // across the transition.
          const legacyLookup = normalizeUaePhone(waIdRaw);
          const resolvedForWrite = normalizeCustomerPhoneForWrite(waIdRaw);
          // Meta always sends E.164 without the plus, so resolvedForWrite
          // should always resolve here. The `?? waIdRaw` fallback is
          // defence — an inbound whose sender ID can't be normalised
          // still creates a row rather than 500ing the webhook.
          const writePhone = resolvedForWrite?.phone ?? waIdRaw;
          const writePhoneNeedsReview = resolvedForWrite?.needsReview ?? true;
          let customer = await prisma.customer.findFirst({
            where: {
              garageId,
              OR: [
                { waId: waIdRaw },
                { waId: legacyLookup },
                { phone: legacyLookup },
                { phone: writePhone },
              ],
            },
            select: { id: true, lang: true },
          });
          if (!customer) {
            customer = await prisma.customer.create({
              data: {
                garageId,
                phone: writePhone,
                waId: writePhone,
                name: writePhone,
                phoneNeedsReview: writePhoneNeedsReview,
              },
              select: { id: true, lang: true },
            });
          }
          await handleInbound({
            garageId,
            customer: { id: customer.id, lang: customer.lang },
            waId: waIdRaw,
            waMessageId: m.id,
            body: m.text?.body ?? "",
          });
        }
      }
    }
  } catch {
    // swallow — never trigger Meta retries on our parse errors
  }
  return new Response("ok", { status: 200 });
}
