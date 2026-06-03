import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

// WhatsApp Business Cloud API integration.
// Mock mode (no WHATSAPP_TOKEN): records WhatsAppMessage rows + returns the link so
// the approve/invoice/pay loop is fully demoable without Meta. Real mode posts to Graph.
export function whatsappEnabled(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

export function appUrl(): string {
  return process.env.APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
}

async function postToGraph(to: string, body: string): Promise<string> {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const res = await fetch(`https://graph.facebook.com/v21.0/${id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  const json = (await res.json()) as { messages?: { id: string }[] };
  if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status}`);
  return json.messages?.[0]?.id ?? `graph-${randomUUID()}`;
}

/** Send an outbound message to a customer (real or mock), recording it on the thread. */
export async function sendWhatsApp(opts: {
  customerId: string;
  waId: string;
  body: string;
  template?: string;
}): Promise<{ mock: boolean; waMessageId: string }> {
  const thread = await prisma.whatsAppThread.upsert({
    where: { waId: opts.waId },
    update: { lastMessageAt: new Date() },
    create: { waId: opts.waId, customerId: opts.customerId, lastMessageAt: new Date() },
  });

  let waMessageId: string;
  let status: string;
  let mock: boolean;
  if (whatsappEnabled()) {
    waMessageId = await postToGraph(opts.waId, opts.body);
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
    },
  });

  return { mock, waMessageId };
}

/** Record an inbound customer message (idempotent on waMessageId). Returns false if a dupe. */
export async function recordInbound(opts: {
  customerId: string;
  waId: string;
  waMessageId: string;
  body: string;
}): Promise<boolean> {
  const existing = await prisma.whatsAppMessage.findUnique({
    where: { waMessageId: opts.waMessageId },
  });
  if (existing) return false; // webhook redelivery — already handled

  const thread = await prisma.whatsAppThread.upsert({
    where: { waId: opts.waId },
    update: { lastMessageAt: new Date() },
    create: { waId: opts.waId, customerId: opts.customerId, lastMessageAt: new Date() },
  });
  await prisma.whatsAppMessage.create({
    data: {
      threadId: thread.id,
      direction: "IN",
      body: opts.body,
      waMessageId: opts.waMessageId,
      status: "received",
    },
  });
  return true;
}
