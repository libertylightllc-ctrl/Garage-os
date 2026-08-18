import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

export default async function ChatsInbox() {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const garageId = session.user.garageId;

  // The parallel customer.findMany that fed the deleted test-conversation
  // picker went away with it — AR 2026-08-19.
  const threads = await prisma.whatsAppThread.findMany({
    where: { garageId },
    include: {
      customer: { select: { name: true, phone: true } },
      messages: { orderBy: { createdAt:"desc"}, take: 1 },
    },
    orderBy: [{ threadStatus:"asc"}, { lastMessageAt:"desc"}],
  });
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

      {/* AR 2026-08-19 — the "Start a test conversation (no Meta
          needed)" panel was DELETED here alongside the
          startTestConversationAction it submitted to. See rule 7 in
          docs/business-rules.md: production write paths never
          fabricate. */}
    </main>
  );
}
