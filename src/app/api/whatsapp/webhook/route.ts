import { prisma } from "@/lib/prisma";
import { handleInbound } from "@/lib/receptionist-engine";

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
          const waId = m.from;
          let customer = await prisma.customer.findFirst({
            where: { garageId, OR: [{ waId }, { phone: waId }] },
            select: { id: true, lang: true },
          });
          if (!customer) {
            // AR 2026-08-19 — hardcoded lang:"ar" removed. The
            // receptionist engine detects language per message via
            // src/lib/lang-detect.ts; stored customer.lang is only
            // a fallback for cold-start outbound-initiated sends.
            // Schema default still applies (ar) as the least-bad
            // starting point until the customer's first inbound
            // arrives and the detector picks the real language.
            customer = await prisma.customer.create({
              data: { garageId, phone: waId, waId, name: waId },
              select: { id: true, lang: true },
            });
          }
          await handleInbound({
            garageId,
            customer: { id: customer.id, lang: customer.lang },
            waId,
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
