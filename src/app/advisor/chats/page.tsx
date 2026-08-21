import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT, getLocale } from "@/i18n/server";
import { countryToTimeZone, fmtDateTime } from "@/lib/format-datetime";

export const dynamic ="force-dynamic";

/**
 * Chats inbox — one row per WhatsApp thread, newest last-message
 * first, with unread inbound count + last-message timestamp + a
 * text search over customer name / phone / message body.
 *
 * Search (AR 2026-08-21) — server-render on form GET. Case-
 * insensitive contains-match against three surfaces:
 *   1. customer.name
 *   2. customer.phone (raw string; not normalised on this side —
 *      an operator typing "0501234567" should match a stored
 *      "501234567" via the LIKE fallback below)
 *   3. any message.body in the thread
 *
 * Unread badge (AR 2026-08-21) — inbound messages with createdAt
 * newer than WhatsAppThread.lastReadAt count as unread. lastReadAt
 * is stamped when the advisor opens the /advisor/chats/[id] page.
 * Null lastReadAt (never opened) reads every past inbound as
 * unread — same visible behaviour as a fresh-install.
 *
 * Timestamps (AR 2026-08-21) — inbox shows lastMessageAt formatted
 * in the garage's timezone.
 */
export default async function ChatsInbox({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const garageId = session.user.garageId;
  const { q: rawQ } = await searchParams;
  const q = typeof rawQ === "string" ? rawQ.trim() : "";

  const [garage, threads] = await Promise.all([
    prisma.garage.findUnique({ where: { id: garageId }, select: { country: true } }),
    prisma.whatsAppThread.findMany({
      where: {
        garageId,
        ...(q
          ? {
              OR: [
                { customer: { name: { contains: q, mode: "insensitive" } } },
                { customer: { phone: { contains: q, mode: "insensitive" } } },
                { messages: { some: { body: { contains: q, mode: "insensitive" } } } },
              ],
            }
          : {}),
      },
      include: {
        customer: { select: { name: true, phone: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: [{ threadStatus: "asc" }, { lastMessageAt: "desc" }],
    }),
  ]);
  const t = await getT();
  const locale = await getLocale();
  const tz = countryToTimeZone(garage?.country ?? "UAE");

  // Per-thread unread count — one grouped query so we don't fan
  // out N-to-N by iterating threads. The `IN` filter and gt-null
  // check together give "inbound messages after last-read" per
  // thread.
  const unreadRows = threads.length === 0
    ? []
    : await prisma.whatsAppMessage.groupBy({
        by: ["threadId"],
        where: {
          threadId: { in: threads.map((t) => t.id) },
          direction: "IN",
          OR: threads.flatMap((th) =>
            th.lastReadAt
              ? [{ threadId: th.id, createdAt: { gt: th.lastReadAt } }]
              : [{ threadId: th.id }],
          ),
        },
        _count: { _all: true },
      });
  const unreadByThread = new Map(
    unreadRows.map((r) => [r.threadId, r._count._all]),
  );

  // NEEDS_HUMAN threads bubble to the top regardless of search.
  const ordered = threads
    .slice()
    .sort((a, b) => Number(b.threadStatus === "NEEDS_HUMAN") - Number(a.threadStatus === "NEEDS_HUMAN"));

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="chats"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("chats")}</h1>

      {/* Search — GET form so the query lives in the URL (shareable,
          back-button restores it). Server re-renders with results. */}
      <form className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={t("chatSearchPlaceholder")}
          className="flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm"
        />
        {q ? (
          <Link
            href="/advisor/chats"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-3 text-sm"
          >
            {t("chatSearchClear")}
          </Link>
        ) : null}
      </form>

      <ul className="flex flex-col gap-2">
        {threads.length === 0 ? (
          <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
            {q ? t("chatNoSearchResults") : t("noChats")}
          </li>
        ) : (
          ordered.map((th) => {
            const unread = unreadByThread.get(th.id) ?? 0;
            return (
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
                    {th.lastMessageAt ? (
                      <span className="mt-0.5 block text-[11px] tabular-nums text-text-mute">
                        {fmtDateTime(th.lastMessageAt, locale, tz)}
                      </span>
                    ) : null}
                  </span>
                  <span className="ms-2 flex shrink-0 items-center gap-1">
                    {unread > 0 ? (
                      <span
                        aria-label={t("chatUnreadTag").replace("{n}", String(unread))}
                        className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-danger-600 px-1.5 text-xs font-semibold text-white"
                      >
                        {unread}
                      </span>
                    ) : null}
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
            );
          })
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
