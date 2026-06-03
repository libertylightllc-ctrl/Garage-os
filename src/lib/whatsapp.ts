import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";

// Multi-tenant WhatsApp transport. Outbound sends from THAT garage's connected number
// (WhatsAppAccount). Falls back to a global Cloud API number, else mock (records only).
export function appUrl(): string {
  return process.env.APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
}

interface SendCreds {
  phoneNumberId: string;
  token: string;
}

async function garageCreds(garageId: string): Promise<SendCreds | null> {
  const acct = await prisma.whatsAppAccount.findUnique({ where: { garageId } });
  // A "mock-" connection (dev/no-Meta) sends in mock mode rather than hitting Graph.
  if (
    acct?.status === "CONNECTED" &&
    acct.phoneNumberId &&
    acct.accessTokenEnc &&
    !acct.phoneNumberId.startsWith("mock-")
  ) {
    return { phoneNumberId: acct.phoneNumberId, token: decryptSecret(acct.accessTokenEnc) };
  }
  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    return { phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, token: process.env.WHATSAPP_TOKEN };
  }
  return null; // mock mode
}

async function postToGraph(creds: SendCreds, to: string, body: string): Promise<string> {
  const res = await fetch(`https://graph.facebook.com/v21.0/${creds.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
  });
  const json = (await res.json()) as { messages?: { id: string }[] };
  if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status}`);
  return json.messages?.[0]?.id ?? `graph-${randomUUID()}`;
}

async function getThread(garageId: string, customerId: string, waId: string) {
  return prisma.whatsAppThread.upsert({
    where: { garageId_waId: { garageId, waId } },
    update: { lastMessageAt: new Date() },
    create: { garageId, customerId, waId, lastMessageAt: new Date() },
  });
}

export async function sendWhatsApp(opts: {
  garageId: string;
  customerId: string;
  waId: string;
  body: string;
  template?: string;
  aiGenerated?: boolean;
}): Promise<{ mock: boolean; waMessageId: string }> {
  const thread = await getThread(opts.garageId, opts.customerId, opts.waId);
  const creds = await garageCreds(opts.garageId);

  let waMessageId: string;
  let status: string;
  let mock: boolean;
  if (creds) {
    waMessageId = await postToGraph(creds, opts.waId, opts.body);
    status = "sent";
    mock = false;
  } else {
    waMessageId = `mock-${randomUUID()}`;
    status = "mock";
    mock = true;
  }

  await prisma.whatsAppMessage.create({
    data: {
      threadId: thread.id,
      direction: "OUT",
      template: opts.template,
      body: opts.body,
      waMessageId,
      status,
      aiGenerated: opts.aiGenerated ?? false,
      state: "SENT",
    },
  });
  return { mock, waMessageId };
}

/** Record an inbound message (idempotent on waMessageId). Returns the thread + whether it was a dupe. */
export async function recordInbound(opts: {
  garageId: string;
  customerId: string;
  waId: string;
  waMessageId: string;
  body: string;
}): Promise<{ threadId: string; mode: "BOT" | "HUMAN"; dupe: boolean }> {
  const thread = await getThread(opts.garageId, opts.customerId, opts.waId);
  const existing = await prisma.whatsAppMessage.findUnique({ where: { waMessageId: opts.waMessageId } });
  if (existing) return { threadId: thread.id, mode: thread.mode as "BOT" | "HUMAN", dupe: true };

  await prisma.whatsAppMessage.create({
    data: {
      threadId: thread.id,
      direction: "IN",
      body: opts.body,
      waMessageId: opts.waMessageId,
      status: "received",
      state: "RECEIVED",
    },
  });
  return { threadId: thread.id, mode: thread.mode as "BOT" | "HUMAN", dupe: false };
}
