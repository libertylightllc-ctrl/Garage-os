"use server";

// AR 2026-08-19 — randomUUID + handleInbound imports removed with
// the deletion of startTestConversationAction + simulateInboundAction
// (see the note at the bottom of this file). No other action in this
// module needs them.
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendWhatsApp } from "@/lib/whatsapp";
import { requireAdvisor } from "@/lib/action-guards";


async function ownedThread(threadId: string, garageId: string) {
  const thread = await prisma.whatsAppThread.findFirst({
    where: { id: threadId, garageId },
    include: { customer: { select: { id: true, lang: true } } },
  });
  if (!thread) throw new Error("Conversation not found");
  return thread;
}

export async function takeOverAction(formData: FormData) {
  const user = await requireAdvisor();
  const thread = await ownedThread(String(formData.get("threadId") ?? ""), user.garageId);
  await prisma.whatsAppThread.update({
    where: { id: thread.id },
    data: { mode: "HUMAN", threadStatus: "OPEN", assignedAdvisorId: user.id },
  });
  revalidatePath(`/advisor/chats/${thread.id}`);
}

export async function releaseAction(formData: FormData) {
  const user = await requireAdvisor();
  const thread = await ownedThread(String(formData.get("threadId") ?? ""), user.garageId);
  await prisma.whatsAppThread.update({ where: { id: thread.id }, data: { mode: "BOT" } });
  revalidatePath(`/advisor/chats/${thread.id}`);
}

export async function approveDraftAction(formData: FormData) {
  const user = await requireAdvisor();
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
  const user = await requireAdvisor();
  const messageId = String(formData.get("messageId") ?? "");
  await prisma.whatsAppMessage.deleteMany({
    where: { id: messageId, state: "PENDING_APPROVAL", thread: { garageId: user.garageId } },
  });
  revalidatePath("/advisor/chats");
}

export async function sendManualAction(formData: FormData) {
  const user = await requireAdvisor();
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

// AR 2026-08-19 — startTestConversationAction + simulateInboundAction
// DELETED. Two "Dev/testing without Meta" actions that let any advisor
// fabricate an inbound customer message directly into the permanent
// WhatsApp record. Prod-audit: 4 fabricated rows found on
// 2026-08-19; zero triggered real outbound sends. Historical rows
// backfilled with `simulated = true` in migration
// 20260819140000_mark_simulated_whatsapp_messages so an audit reader
// can distinguish them from real customer speech. The UI buttons in
// src/app/advisor/chats/{page,[id]/page}.tsx were removed in the
// same commit. See business-rules.md rule 7 (Production write paths
// never fabricate).
