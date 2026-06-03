"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendWhatsApp } from "@/lib/whatsapp";
import { handleInbound } from "@/lib/receptionist-engine";

async function requireStaff() {
  const session = await auth();
  if (!session?.user || !["ADVISOR", "OWNER"].includes(session.user.role)) {
    throw new Error("Not authorized");
  }
  return session.user;
}

async function ownedThread(threadId: string, garageId: string) {
  const thread = await prisma.whatsAppThread.findFirst({
    where: { id: threadId, garageId },
    include: { customer: { select: { id: true, lang: true } } },
  });
  if (!thread) throw new Error("Conversation not found");
  return thread;
}

export async function takeOverAction(formData: FormData) {
  const user = await requireStaff();
  const thread = await ownedThread(String(formData.get("threadId") ?? ""), user.garageId);
  await prisma.whatsAppThread.update({
    where: { id: thread.id },
    data: { mode: "HUMAN", threadStatus: "OPEN", assignedAdvisorId: user.id },
  });
  revalidatePath(`/advisor/chats/${thread.id}`);
}

export async function releaseAction(formData: FormData) {
  const user = await requireStaff();
  const thread = await ownedThread(String(formData.get("threadId") ?? ""), user.garageId);
  await prisma.whatsAppThread.update({ where: { id: thread.id }, data: { mode: "BOT" } });
  revalidatePath(`/advisor/chats/${thread.id}`);
}

export async function approveDraftAction(formData: FormData) {
  const user = await requireStaff();
  const messageId = String(formData.get("messageId") ?? "");
  const msg = await prisma.whatsAppMessage.findFirst({
    where: { id: messageId, state: "PENDING_APPROVAL", thread: { garageId: user.garageId } },
    include: { thread: true },
  });
  if (msg) {
    await sendWhatsApp({
      garageId: msg.thread.garageId,
      customerId: msg.thread.customerId,
      waId: msg.thread.waId,
      body: msg.body ?? "",
      aiGenerated: true,
    });
    await prisma.whatsAppMessage.delete({ where: { id: msg.id } });
    revalidatePath(`/advisor/chats/${msg.threadId}`);
  }
}

export async function discardDraftAction(formData: FormData) {
  const user = await requireStaff();
  const messageId = String(formData.get("messageId") ?? "");
  await prisma.whatsAppMessage.deleteMany({
    where: { id: messageId, state: "PENDING_APPROVAL", thread: { garageId: user.garageId } },
  });
  revalidatePath("/advisor/chats");
}

export async function sendManualAction(formData: FormData) {
  const user = await requireStaff();
  const thread = await ownedThread(String(formData.get("threadId") ?? ""), user.garageId);
  const body = String(formData.get("body") ?? "").trim();
  if (body) {
    await sendWhatsApp({
      garageId: thread.garageId,
      customerId: thread.customerId,
      waId: thread.waId,
      body,
    });
    await prisma.whatsAppThread.update({ where: { id: thread.id }, data: { threadStatus: "OPEN" } });
  }
  revalidatePath(`/advisor/chats/${thread.id}`);
}

// Dev/testing without Meta: pick a customer and inject their first message → routes via AI.
export async function startTestConversationAction(formData: FormData) {
  const user = await requireStaff();
  const customerId = String(formData.get("customerId") ?? "");
  const body = String(formData.get("body") ?? "").trim() || "is my car ready?";
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, garageId: user.garageId },
    select: { id: true, lang: true, phone: true, waId: true },
  });
  if (!customer) throw new Error("Customer not found");
  await handleInbound({
    garageId: user.garageId,
    customer: { id: customer.id, lang: customer.lang },
    waId: customer.waId ?? customer.phone,
    waMessageId: `sim-${randomUUID()}`,
    body,
  });
  revalidatePath("/advisor/chats");
}

// Dev/testing without Meta: inject a customer message and run the AI engine.
export async function simulateInboundAction(formData: FormData) {
  const user = await requireStaff();
  const thread = await ownedThread(String(formData.get("threadId") ?? ""), user.garageId);
  const body = String(formData.get("body") ?? "").trim();
  if (body) {
    await handleInbound({
      garageId: thread.garageId,
      customer: { id: thread.customer.id, lang: thread.customer.lang },
      waId: thread.waId,
      waMessageId: `sim-${randomUUID()}`,
      body,
    });
  }
  revalidatePath(`/advisor/chats/${thread.id}`);
}
