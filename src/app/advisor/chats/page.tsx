import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { startTestConversationAction } from "@/app/actions/chat";

export const dynamic ="force-dynamic";

export default async function ChatsInbox() {
  const session = await requireRole("ADVISOR");
  const garageId = session.user.garageId;

  const [threads, customers] = await Promise.all([
    prisma.whatsAppThread.findMany({
      where: { garageId },
      include: {
        customer: { select: { name: true, phone: true } },
        messages: { orderBy: { createdAt:"desc"}, take: 1 },
      },
      orderBy: [{ threadStatus:"asc"}, { lastMessageAt:"desc"}],
    }),
    prisma.customer.findMany({ where: { garageId }, orderBy: { createdAt:"asc"} }),
  ]);
  const t = await getT();
  const ordered = threads
    .slice()
    .sort((a, b) => Number(b.threadStatus ==="NEEDS_HUMAN") - Number(a.threadStatus ==="NEEDS_HUMAN"));

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="chats"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("chats")}</h1>

      <ul className="flex flex-col gap-2">
        {threads.length === 0 ? (
          <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
            {t("noChats")}
          </li>
        ) : (
          ordered.map((th) => (
            <li key={th.id}>
              <Link
                href={`/advisor/chats/${th.id}`}
                className="flex items-center justify-between rounded-xl border border-border p-3 text-sm hover:bg-surface-2 transition-colors"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{th.customer.name}</span>
                  <span className="block truncate text-text-mute">
                    {th.messages[0]?.body ?? ""}
                  </span>
                </span>
                <span className="ms-2 flex shrink-0 items-center gap-1">
                  {th.threadStatus ==="NEEDS_HUMAN"? (
                    <span className="inline-flex items-center rounded-full bg-danger-50 px-2 py-0.5 text-xs font-semibold text-danger-700 dark:bg-danger-500/10 dark:text-danger-500">
                      {t("needsHuman")}
                    </span>
                  ) : null}
                  {th.mode ==="HUMAN"? (
                    <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-mute">
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
          className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3 text-sm"
        >
          <span className="text-xs font-medium text-text-mute">
            {t("startTestConvo")}
          </span>
          <select
            name="customerId"
            className="rounded-md border border-border bg-transparent px-2 py-1"
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
              className="flex-1 rounded-md border border-border bg-transparent px-2 py-1"
            />
            <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              {t("send")}
            </button>
          </div>
        </form>
      ) : null}
    </main>
  );
}
