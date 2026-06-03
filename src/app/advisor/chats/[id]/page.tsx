import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import {
  takeOverAction,
  releaseAction,
  approveDraftAction,
  discardDraftAction,
  sendManualAction,
  simulateInboundAction,
} from "@/app/actions/chat";

export const dynamic = "force-dynamic";

export default async function ChatThread({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireRole("ADVISOR");
  const t = await getT();

  const thread = await prisma.whatsAppThread.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      customer: { select: { name: true, phone: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!thread) notFound();

  const drafts = thread.messages.filter((m) => m.state === "PENDING_APPROVAL");
  const convo = thread.messages.filter((m) => m.state !== "PENDING_APPROVAL");
  const field =
    "w-full rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 p-6">
      <AppNav role="ADVISOR" active="chats" />
      <div className="flex items-center justify-between">
        <div>
          <Link href="/advisor/chats" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
            ← {t("chats")}
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{thread.customer.name}</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {thread.customer.phone} · {thread.mode === "HUMAN" ? t("humanMode") : t("botMode")}
          </p>
        </div>
        {thread.mode === "BOT" ? (
          <form action={takeOverAction}>
            <input type="hidden" name="threadId" value={thread.id} />
            <button className="rounded-md border border-black/15 px-3 py-1 text-sm font-medium dark:border-white/20">
              {t("takeOver")}
            </button>
          </form>
        ) : (
          <form action={releaseAction}>
            <input type="hidden" name="threadId" value={thread.id} />
            <button className="rounded-md border border-black/15 px-3 py-1 text-sm font-medium dark:border-white/20">
              {t("release")}
            </button>
          </form>
        )}
      </div>

      {/* Pending AI drafts to approve */}
      {drafts.map((d) => (
        <div key={d.id} className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm dark:border-yellow-800 dark:bg-yellow-950">
          <div className="mb-1 text-xs font-medium text-yellow-800 dark:text-yellow-300">
            {t("pendingDraft")}
          </div>
          <p className="mb-2">{d.body}</p>
          <div className="flex gap-2">
            <form action={approveDraftAction}>
              <input type="hidden" name="messageId" value={d.id} />
              <button className="rounded-md bg-green-600 px-3 py-1 text-xs font-semibold text-white">
                {t("approveSend")}
              </button>
            </form>
            <form action={discardDraftAction}>
              <input type="hidden" name="messageId" value={d.id} />
              <button className="rounded-md border border-black/15 px-3 py-1 text-xs dark:border-white/20">
                {t("discard")}
              </button>
            </form>
          </div>
        </div>
      ))}

      {/* Conversation */}
      <ul className="flex flex-col gap-2">
        {convo.map((m) => (
          <li
            key={m.id}
            className={
              "max-w-[80%] rounded-lg px-3 py-2 text-sm " +
              (m.direction === "IN"
                ? "self-start bg-zinc-100 dark:bg-zinc-800"
                : "self-end bg-blue-600 text-white")
            }
          >
            {m.body}
            {m.aiGenerated ? (
              <span className="ms-2 text-[10px] opacity-70">AI</span>
            ) : null}
          </li>
        ))}
      </ul>

      {/* Manual reply (advisor) */}
      <form action={sendManualAction} className="flex gap-2">
        <input type="hidden" name="threadId" value={thread.id} />
        <input name="body" placeholder={t("message")} required className={field} />
        <button className="rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black">
          {t("send")}
        </button>
      </form>

      {/* Dev: simulate a customer message */}
      <form action={simulateInboundAction} className="flex gap-2 border-t border-dashed border-black/15 pt-3 dark:border-white/20">
        <input type="hidden" name="threadId" value={thread.id} />
        <input name="body" placeholder={t("simulateInbound")} className={field} />
        <button className="rounded-md border border-black/15 px-3 py-1 text-sm dark:border-white/20">
          ⤵
        </button>
      </form>
    </main>
  );
}
