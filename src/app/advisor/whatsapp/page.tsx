import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { WhatsAppStatusPanel } from "@/components/whatsapp-status";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Advisor's read-only view of the garage WhatsApp connection.
 *
 * The advisor sends WhatsApp messages indirectly — through
 * sendReminderAction, sendDueRemindersAction, etc — but they
 * previously had no way to confirm the connection was actually live
 * for their garage. This page surfaces that, plus the recent-outbound
 * log so they can verify their own sends went through.
 *
 * Connect / disconnect remain owner-only (/owner/whatsapp). The
 * footer of WhatsAppStatusPanel points there.
 */
export default async function AdvisorWhatsApp() {
  const session = await requireRole("ADVISOR");
  const t = await getT();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="whatsapp" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("waStatusTitle")}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("waStatusSubtitleAdvisor")}
        </p>
      </div>

      <WhatsAppStatusPanel
        garageId={session.user.garageId}
        helpForRole="advisor"
      />

      {/* Quick shortcuts to the actions the advisor most often pairs
          with this page — they almost always come here BECAUSE they
          want to send a reminder. Surface those as direct links. */}
      <div className="flex flex-wrap gap-2">
        <Link
          href="/advisor/reminders"
          className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {t("waStatusGoReminders")}
        </Link>
        <Link
          href="/advisor/chats"
          className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {t("waStatusGoChats")}
        </Link>
      </div>
    </main>
  );
}
