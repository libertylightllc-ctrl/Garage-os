"use server";

// AR 2026-08-19 — randomUUID + handleInbound imports removed with
// the deletion of startTestConversationAction + simulateInboundAction
// (see the note at the bottom of this file). No other action in this
// module needs them.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendWhatsApp } from "@/lib/whatsapp";
import { requireAdvisor } from "@/lib/action-guards";
import { hasUnfilledPlaceholders } from "@/lib/chat-draft";


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

/**
 * Approve an AI draft and ship it to the customer.
 *
 * AR 2026-08-19 rewrite. The old shape sent `msg.body` verbatim
 * with no check. INC 2026-08-18: an advisor clicked Approve on an
 * unedited draft and the customer received "[مسودة] إجمالي السعر
 * التقديري هو ___ درهم شامل الضريبة. هل تريد المتابعة؟" — literal
 * "draft" marker + `___` where the price belonged. Business rule 4
 * (WhatsApp hand-off is not delivery) makes wa.me mis-messages
 * unretractable.
 *
 * New shape:
 *   1. Accept an edited body from the draft card's textarea. Fall
 *      back to the stored body if the form field is missing (older
 *      clients / bookmarked POST).
 *   2. Trim + reject blank.
 *   3. Run hasUnfilledPlaceholders() from src/lib/chat-draft. On
 *      hit → persist the edited body (so the advisor keeps their
 *      typing) and redirect back to the thread with
 *      ?formError=draft-unfilled&msgId=<id>. The chat detail page
 *      renders a banner on THAT draft card telling the advisor to
 *      fill the placeholder.
 *   4. If clean, persist the edited body (idempotent write), send
 *      via sendWhatsApp, delete the draft row.
 */
export async function approveDraftAction(formData: FormData) {
  const user = await requireAdvisor();
  const messageId = String(formData.get("messageId") ?? "");
  const msg = await prisma.whatsAppMessage.findFirst({
    where: { id: messageId, state: "PENDING_APPROVAL", thread: { garageId: user.garageId } },
    include: { thread: true },
  });
  if (!msg) return;

  // The textarea in the draft card carries the (possibly-edited)
  // body. Missing → fall back to whatever's currently stored.
  const raw = formData.get("body");
  const editedBody =
    typeof raw === "string" ? raw.trim() : (msg.body ?? "").trim();

  if (editedBody === "" || hasUnfilledPlaceholders(editedBody)) {
    // Persist the advisor's typing before bouncing back — losing
    // their edits on a validation failure would be its own bug.
    // Only write when the body actually changed to avoid a
    // spurious updatedAt bump.
    if (editedBody !== (msg.body ?? "")) {
      await prisma.whatsAppMessage.update({
        where: { id: msg.id },
        data: { body: editedBody },
      });
    }
    revalidatePath(`/advisor/chats/${msg.threadId}`);
    redirect(`/advisor/chats/${msg.threadId}?formError=draft-unfilled&msgId=${msg.id}`);
  }

  // Persist the edited body (if any) then send. Combined in a
  // transaction so an approve-race can't ship the OLD body while
  // the update is still pending.
  await prisma.$transaction(async (tx) => {
    if (editedBody !== (msg.body ?? "")) {
      await tx.whatsAppMessage.update({
        where: { id: msg.id },
        data: { body: editedBody },
      });
    }
  });
  await sendWhatsApp({
    garageId: msg.thread.garageId,
    customerId: msg.thread.customerId,
    waId: msg.thread.waId,
    body: editedBody,
    aiGenerated: true,
  });
  await prisma.whatsAppMessage.delete({ where: { id: msg.id } });
  revalidatePath(`/advisor/chats/${msg.threadId}`);
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
