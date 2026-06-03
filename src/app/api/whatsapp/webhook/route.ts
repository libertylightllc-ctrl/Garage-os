import { prisma } from "@/lib/prisma";
import { recordInbound } from "@/lib/whatsapp";

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

// Inbound messages. Always 200 so Meta stops retrying; dedupe on message id.
export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as {
      entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[];
    };
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          const waId = m.from;
          const customer = await prisma.customer.findFirst({
            where: { OR: [{ waId }, { phone: waId }] },
            select: { id: true },
          });
          if (customer) {
            await recordInbound({
              customerId: customer.id,
              waId,
              waMessageId: m.id,
              body: m.text?.body ?? "",
            });
          }
        }
      }
    }
  } catch {
    // swallow — never make Meta retry on our parse errors
  }
  return new Response("ok", { status: 200 });
}
