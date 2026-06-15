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

export const dynamic ="force-dynamic";

export default async function ChatThread({ params }: { params: Promise<{ id: string }> }) {
 const { id } = await params;
 const session = await requireRole("ADVISOR");
 const t = await getT();

 const thread = await prisma.whatsAppThread.findFirst({
  where: { id, garageId: session.user.garageId },
  include: {
   customer: { select: { name: true, phone: true } },
   messages: { orderBy: { createdAt:"asc"} },
  },
 });
 if (!thread) notFound();

 const drafts = thread.messages.filter((m) => m.state ==="PENDING_APPROVAL");
 const convo = thread.messages.filter((m) => m.state !=="PENDING_APPROVAL");
 const field =
 "w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm";

 return (
  <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-4 p-6">
   <AppNav role="ADVISOR" active="chats"/>
   <div className="flex items-center justify-between">
    <div>
     <Link href="/advisor/chats" className="text-sm text-text-mute hover:underline">
      ← {t("chats")}
     </Link>
     <h1 className="mt-1 text-xl font-semibold tracking-tight">{thread.customer.name}</h1>
     <p className="text-xs text-text-mute">
      {thread.customer.phone} · {thread.mode ==="HUMAN"? t("humanMode") : t("botMode")}
     </p>
    </div>
    {thread.mode ==="BOT"? (
     <form action={takeOverAction}>
      <input type=" hidden" name="threadId" value={thread.id} />
      <button className="rounded-md border border-border px-3 py-1 text-sm font-medium">
       {t("takeOver")}
      </button>
     </form>
    ) : (
     <form action={releaseAction}>
      <input type=" hidden" name="threadId" value={thread.id} />
      <button className="rounded-md border border-border px-3 py-1 text-sm font-medium">
       {t("release")}
      </button>
     </form>
    )}
   </div>

   {/* Pending AI drafts to approve */}
   {drafts.map((d) => (
    <div key={d.id} className="rounded-xl border border-warning-500/40 bg-warning-50 p-3 text-sm dark:border-warning-500/30 dark:bg-warning-500/10">
     <div className="mb-1 text-xs font-medium text-yellow-800 dark:text-yellow-300">
      {t("pendingDraft")}
     </div>
     <p className="mb-2">{d.body}</p>
     <div className="flex gap-2">
      <form action={approveDraftAction}>
       <input type=" hidden" name="messageId" value={d.id} />
       <button className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-xs font-semibold bg-success-600 text-white hover:bg-success-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
        {t("approveSend")}
       </button>
      </form>
      <form action={discardDraftAction}>
       <input type=" hidden" name="messageId" value={d.id} />
       <button className="rounded-md border border-border px-3 py-1 text-xs">
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
      "max-w-[80%] rounded-lg px-3 py-2 text-sm"+
       (m.direction ==="IN"
        ?"self-start bg-surface-2"
        :"self-end bg-blue-600 text-white")
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
    <input type=" hidden" name="threadId" value={thread.id} />
    <input name="body" placeholder={t("message")} required className={field} />
    <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
     {t("send")}
    </button>
   </form>

   {/* Dev: simulate a customer message */}
   <form action={simulateInboundAction} className="flex gap-2 border-t border-dashed border-border pt-3">
    <input type=" hidden" name="threadId" value={thread.id} />
    <input name="body" placeholder={t("simulateInbound")} className={field} />
    <button className="rounded-md border border-border px-3 py-1 text-sm">
     ⤵
    </button>
   </form>
  </main>
 );
}
