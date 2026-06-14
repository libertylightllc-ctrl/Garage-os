import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getT } from "@/i18n/server";

/**
 * Read-only WhatsApp connection status panel for the advisor + cashier
 * surfaces. The owner page (/owner/whatsapp) handles connect /
 * disconnect; advisor and cashier shouldn't change garage-wide
 * settings, but they DO need a single place that answers:
 *
 *   1. Is the connector live for our garage right now?
 *   2. What number does the customer see when we send?
 *   3. What did *I* send recently? (mock send log)
 *
 * recentDirection='OUT' so only outbound messages show — this is the
 * 'did my send actually go out?' surface, not an inbox. (Real inbox =
 * future slice 'WhatsApp inbox per role'.)
 *
 * `actionsByRole` is an optional list of action buttons rendered below
 * the connection card. Each role wires its own actions (Send reminder
 * for advisor, Send invoice for cashier) — keeps the component
 * role-agnostic.
 */
export async function WhatsAppStatusPanel({
  garageId,
  recentLimit = 10,
  helpForRole,
}: {
  garageId: string;
  recentLimit?: number;
  helpForRole: "advisor" | "cashier";
}) {
  const t = await getT();
  const [acct, recent] = await Promise.all([
    prisma.whatsAppAccount.findUnique({ where: { garageId } }),
    prisma.whatsAppMessage.findMany({
      where: { direction: "OUT", thread: { garageId } },
      orderBy: { createdAt: "desc" },
      take: recentLimit,
      include: { thread: { include: { customer: true } } },
    }),
  ]);
  const connected = acct?.status === "CONNECTED";

  return (
    <div className="flex flex-col gap-4">
      {/* Connection card — green when live, amber when not. The
          'who can change this' line is role-specific because advisors
          and cashiers can't connect themselves; they should ask the
          owner. */}
      <div
        className={
          "flex flex-col gap-2 rounded-lg border p-4 " +
          (connected
            ? "border-emerald-500/40 bg-emerald-50 dark:border-emerald-700/40 dark:bg-emerald-950/30"
            : "border-amber-500/40 bg-amber-50 dark:border-amber-700/40 dark:bg-amber-950/30")
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {connected ? "🟢" : "🟡"}{" "}
            {connected ? t("waConnected") : t("waStatusNotConnected")}
          </span>
          {connected && acct?.phoneNumber ? (
            <span className="text-sm tabular-nums">{acct.phoneNumber}</span>
          ) : null}
        </div>
        <p className="text-xs text-zinc-600 dark:text-zinc-300">
          {connected
            ? t(
                helpForRole === "advisor"
                  ? "waStatusReadyAdvisor"
                  : "waStatusReadyCashier",
              )
            : t("waStatusAskOwner")}
        </p>
      </div>

      {/* Recent outbound — last N OUT messages across the garage. Lets
          the role confirm 'yes, my send actually fired' without having
          to dig into Vercel logs. Mock vs real is invisible at this
          layer: WhatsAppMessage rows are written by sendWhatsApp()
          regardless. */}
      <div className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {t("waRecentOutbound")}
          <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            {recent.length}
          </span>
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("waRecentEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {recent.map((m) => (
              <li
                key={m.id}
                className="flex flex-col gap-1 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {m.thread.customer.name}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {m.thread.customer.phone} ·{" "}
                    {m.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                </div>
                {/* Template + body. Template label is the high-signal
                    identifier (maintenance_reminder, invoice_link,
                    estimate_link) — body is a teaser, not the full
                    text, so a single screen of recent sends stays
                    scannable. */}
                <div className="text-xs text-zinc-600 dark:text-zinc-300">
                  {m.template ? (
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                      {m.template}
                    </span>
                  ) : null}{" "}
                  {m.body ? (
                    <span className="line-clamp-2">{m.body}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer: link to the owner connect surface for completeness so
          the role knows where to point the owner when they need to
          change the connection. */}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {t("waStatusOwnerControls")}{" "}
        <Link href="/owner/whatsapp" className="underline">
          /owner/whatsapp
        </Link>
      </p>
    </div>
  );
}
