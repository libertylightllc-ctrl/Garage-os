import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { startTestConversationAction } from "@/app/actions/chat";

export const dynamic = "force-dynamic";

export default async function ChatsInbox() {
  const session = await requireRole("ADVISOR");
  const garageId = session.user.garageId;

  const [threads, customers] = await Promise.all([
    prisma.whatsAppThread.findMany({
      where: { garageId },
      include: {
        customer: { select: { name: true, phone: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: [{ threadStatus: "asc" }, { lastMessageAt: "desc" }],
    }),
    prisma.customer.findMany({ where: { garageId }, orderBy: { createdAt: "asc" } }),
  ]);
  const t = await getT();
  const ordered = threads
    .slice()
    .sort((a, b) => Number(b.threadStatus === "NEEDS_HUMAN") - Number(a.threadStatus === "NEEDS_HUMAN"));

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="chats" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("chats")}</h1>

      <ul className="flex flex-col gap-2">
        {threads.length === 0 ? (
          <li className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-zinc-500 dark:border-white/20 dark:text-zinc-400">
            {t("noChats")}
          </li>
        ) : (
          ordered.map((th) => (
            <li key={th.id}>
              <Link
                href={`/advisor/chats/${th.id}`}
                className="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{th.customer.name}</span>
                  <span className="block truncate text-zinc-500 dark:text-zinc-400">
                    {th.messages[0]?.body ?? ""}
                  </span>
                </span>
                <span className="ms-2 flex shrink-0 items-center gap-1">
                  {th.threadStatus === "NEEDS_HUMAN" ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                      {t("needsHuman")}
                    </span>
                  ) : null}
                  {th.mode === "HUMAN" ? (
                    <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs dark:bg-zinc-700">
                      {t("humanMode")}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))
        )}
      </ul>

      {/* Dev: start a test conversation without Meta */}
      {customers.length > 0 ? (
        <form
          action={startTestConversationAction}
          className="flex flex-col gap-2 rounded-lg border border-dashed border-black/15 p-3 text-sm dark:border-white/20"
        >
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            {t("startTestConvo")}
          </span>
          <select
            name="customerId"
            className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.phone}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input
              name="body"
              placeholder="is my car ready? / how much? / I want a refund"
              className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20"
            />
            <button className="rounded-md bg-zinc-900 px-3 py-1 font-medium text-white dark:bg-white dark:text-black">
              {t("send")}
            </button>
          </div>
        </form>
      ) : null}
    </main>
  );
}
