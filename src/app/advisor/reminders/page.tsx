import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { reminderTypeKey } from "@/i18n/config";
import type { MessageKey } from "@/i18n/config";
import { getT, getLocale } from "@/i18n/server";
import {
  sendReminderAction,
  sendDueRemindersAction,
  cancelReminderAction,
} from "@/app/actions/reminders";

export const dynamic = "force-dynamic";

const day = (d: Date) => d.toISOString().slice(0, 10);

const BTN =
  "rounded-md border border-black/15 px-3 py-1 text-xs font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10";
const BTN_PRIMARY =
  "rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:bg-white dark:text-black";

type T = (k: MessageKey) => string;

interface ReminderRow {
  id: string;
  type: string;
  status: string;
  dueAt: Date;
  sentAt: Date | null;
  vehicle: {
    id: string;
    make: string;
    model: string;
    plate: string;
    customer: { name: string };
  };
}

// ─── Month helpers ──────────────────────────────────────────────
// 'YYYY-MM' is the URL key so the param matches what <input
// type="month"> emits (no JS conversion needed). All math here works
// in UTC to keep dueAt comparisons consistent with what we store.
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function parseMonth(raw: string | undefined, fallback: Date): { year: number; month: number } {
  if (raw) {
    const m = raw.match(/^(\d{4})-(\d{2})$/);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      if (y >= 1970 && y <= 9999 && mo >= 1 && mo <= 12) {
        return { year: y, month: mo };
      }
    }
  }
  return { year: fallback.getUTCFullYear(), month: fallback.getUTCMonth() + 1 };
}
function monthStartUtc(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}
function monthEndUtc(year: number, month: number): Date {
  // First day of NEXT month, minus 1 ms — inclusive end-of-month bound
  // used for the dueAt range filter.
  return new Date(Date.UTC(year, month, 1) - 1);
}
function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const ms = monthStartUtc(year, month);
  ms.setUTCMonth(ms.getUTCMonth() + delta);
  return { year: ms.getUTCFullYear(), month: ms.getUTCMonth() + 1 };
}
function monthKeyFromYM(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// Group reminders within a single day by vehicleId. Vehicle order =
// stable alphabetical by 'Make Model · plate' so the same row appears
// in the same place across renders.
function groupByVehicle(rs: ReminderRow[]) {
  const map = new Map<string, { vehicle: ReminderRow["vehicle"]; rs: ReminderRow[] }>();
  for (const r of rs) {
    const g = map.get(r.vehicle.id);
    if (g) g.rs.push(r);
    else map.set(r.vehicle.id, { vehicle: r.vehicle, rs: [r] });
  }
  return Array.from(map.values()).sort((a, b) => {
    const al = `${a.vehicle.make} ${a.vehicle.model} ${a.vehicle.plate}`;
    const bl = `${b.vehicle.make} ${b.vehicle.model} ${b.vehicle.plate}`;
    return al.localeCompare(bl);
  });
}

// Cheap server-side text filter — runs once, up front, so monthly
// counts in the headers reflect the filter rather than the DB total.
function matchesFilter(r: ReminderRow, q: string, t: T): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [
    t(reminderTypeKey(r.type)),
    r.vehicle.make,
    r.vehicle.model,
    r.vehicle.plate,
    r.vehicle.customer.name,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

export default async function RemindersQueue({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; month?: string }>;
}) {
  const session = await requireRole("ADVISOR");
  const t = await getT();
  const locale = await getLocale();
  const now = new Date();
  const { q: rawQ, month: rawMonth } = await searchParams;
  const q = (rawQ ?? "").trim();

  // Selected month — defaults to the current calendar month so the
  // first page render is always 'this is what's due THIS month'.
  const { year, month } = parseMonth(rawMonth, now);
  const selStart = monthStartUtc(year, month);
  const selEnd = monthEndUtc(year, month);
  const selKey = monthKeyFromYM(year, month);
  // Long month name in the user's locale ('August 2026' / 'أغسطس 2026').
  // Intl is fine in a server component; runs at request time.
  const monthLabel = selStart.toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const prevYM = shiftMonth(year, month, -1);
  const nextYM = shiftMonth(year, month, +1);

  // Pull every active reminder for the garage in one shot. SENT rows
  // are dropped here — the monthly view is about 'still to send'. The
  // 'Sent' audit section that used to live at the bottom moved out
  // because it didn't fit the per-month model cleanly.
  const all = await prisma.reminder.findMany({
    where: {
      garageId: session.user.garageId,
      status: "SCHEDULED",
    },
    include: { vehicle: { include: { customer: true } } },
    orderBy: { dueAt: "asc" },
  });

  const filtered = all.filter((r) => matchesFilter(r, q, t));

  // Reminders that fall inside the selected month.
  const inMonth = filtered.filter(
    (r) => r.dueAt >= selStart && r.dueAt <= selEnd,
  );

  // Group reminders in the selected month by dueAt-day (YYYY-MM-DD).
  // Map preserves insertion order; rows are already sorted by dueAt
  // asc in the DB query, so the first occurrence of each date dictates
  // the order — earliest day at the top.
  const byDay = new Map<string, ReminderRow[]>();
  for (const r of inMonth) {
    const k = day(r.dueAt);
    const list = byDay.get(k);
    if (list) list.push(r);
    else byDay.set(k, [r]);
  }

  // Other months with at least one (filtered) reminder, EXCLUDING the
  // selected one. Used to render collapsible 'jump here' rows under
  // the main view so the advisor sees pipeline without leaving the page.
  const otherMonths = new Map<string, number>();
  for (const r of filtered) {
    const k = monthKey(r.dueAt);
    if (k === selKey) continue;
    otherMonths.set(k, (otherMonths.get(k) ?? 0) + 1);
  }
  const otherMonthList = Array.from(otherMonths.entries())
    .map(([key, count]) => {
      const [yStr, moStr] = key.split("-");
      const y = Number(yStr);
      const mo = Number(moStr);
      const label = monthStartUtc(y, mo).toLocaleDateString(locale, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
      return { key, year: y, month: mo, label, count };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  // Whether any reminders in the selected month are due on or before
  // today — drives the 'Send to all overdue this month →' bulk button.
  const hasOverdueInMonth = inMonth.some((r) => r.dueAt <= now);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="reminders" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("remindersTitle")}</h1>

      {/* Text filter — kept from prior slice. Useful when a single
          month still has 20+ reminders ('show me only Oil'). Form
          submits GET so URL stays bookmarkable; the selected month
          carries over via the hidden input. */}
      <form method="get" className="flex flex-wrap gap-2">
        <input type="hidden" name="month" value={selKey} />
        <input
          name="q"
          type="search"
          defaultValue={q}
          placeholder={t("remindersFilterPlaceholder")}
          className="min-w-40 flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
        />
        <button className={BTN}>{t("remindersFilterApply")}</button>
        {q ? (
          <Link
            href={`/advisor/reminders?month=${selKey}`}
            className={BTN}
          >
            {t("remindersFilterClear")}
          </Link>
        ) : null}
      </form>

      {/* Month picker — three controls share the same line:
            ‹ prev  |  big month label  |  next ›  |  native <input type=month>
          Prev/next are plain Links → server re-renders with the new
          month. The native picker uses a GET form so a date jump
          works without JS too. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
        <div className="flex items-center gap-2">
          <Link
            href={`/advisor/reminders?month=${monthKeyFromYM(prevYM.year, prevYM.month)}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className={BTN}
            aria-label={t("remindersPrevMonth")}
          >
            ‹
          </Link>
          <span className="text-lg font-semibold tabular-nums">{monthLabel}</span>
          <Link
            href={`/advisor/reminders?month=${monthKeyFromYM(nextYM.year, nextYM.month)}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className={BTN}
            aria-label={t("remindersNextMonth")}
          >
            ›
          </Link>
        </div>
        <form method="get" className="flex items-center gap-2">
          {q ? <input type="hidden" name="q" value={q} /> : null}
          <label className="text-xs text-zinc-500 dark:text-zinc-400">
            {t("remindersJumpToMonth")}
          </label>
          <input
            type="month"
            name="month"
            defaultValue={selKey}
            className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
          />
          <button className={BTN}>{t("remindersFilterApply")}</button>
        </form>
      </div>

      {/* Summary line — 'N reminders due in August 2026'. Reflects
          the FILTERED count (i.e. respects ?q=), not the raw DB total. */}
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        <span className="font-semibold tabular-nums">{inMonth.length}</span>{" "}
        {inMonth.length === 1
          ? t("remindersSummarySingular")
          : t("remindersSummaryPlural")}{" "}
        {monthLabel}
      </p>

      {/* Empty states — distinguishes 'no data at all' from 'no data
          for this month' so the advisor doesn't think the page is
          broken when they navigate to an empty future month. */}
      {all.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("noReminders")}
        </p>
      ) : null}
      {all.length > 0 && filtered.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("remindersFilterNoMatch")}
        </p>
      ) : null}
      {filtered.length > 0 && inMonth.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("remindersMonthEmpty")}
        </p>
      ) : null}

      {/* Selected-month view — for each due date in chronological
          order, render the reminders grouped by vehicle. Past-due
          dates within the selected month get a red 'overdue' chip so
          the advisor still sees urgency inside the month picker. */}
      {inMonth.length > 0 ? (
        <section className="flex flex-col gap-4">
          {hasOverdueInMonth ? (
            <div className="flex justify-end">
              <form action={sendDueRemindersAction}>
                <button className={BTN_PRIMARY}>
                  {t("remindersBulkSendOverdue")}
                </button>
              </form>
            </div>
          ) : null}
          {Array.from(byDay.entries()).map(([d, list]) => {
            const dateObj = new Date(`${d}T00:00:00Z`);
            const overdue = dateObj <= now;
            const groups = groupByVehicle(list);
            return (
              <div key={d} className="flex flex-col gap-2">
                <h2 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="text-zinc-700 dark:text-zinc-200">
                    {t("dueOn")} {d}
                  </span>
                  <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                    {list.length}
                  </span>
                  {overdue ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900 dark:bg-red-950/60 dark:text-red-200">
                      {t("remindersBucketOverdue")}
                    </span>
                  ) : null}
                </h2>
                <ul className="flex flex-col gap-2">
                  {groups.map((g) => (
                    <li
                      key={g.vehicle.id}
                      className={
                        "flex flex-col gap-2 rounded-lg border p-3 text-sm " +
                        (overdue
                          ? "border-red-500/40 bg-red-50 dark:border-red-700/40 dark:bg-red-950/30"
                          : "border-black/10 dark:border-white/15")
                      }
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <span className="font-semibold">
                            {g.vehicle.make} {g.vehicle.model}
                          </span>
                          <span className="ms-2 text-zinc-600 dark:text-zinc-300">
                            {g.vehicle.plate} · {g.vehicle.customer.name}
                          </span>
                        </span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          {g.rs.length}{" "}
                          {g.rs.length === 1
                            ? t("remindersReminderSingular")
                            : t("remindersReminderPlural")}
                        </span>
                      </div>
                      <ul className="flex flex-col gap-1 ps-2">
                        {g.rs.map((r) => (
                          <li
                            key={r.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-black/5 bg-white/60 px-2 py-1.5 dark:border-white/10 dark:bg-zinc-900/40"
                          >
                            <span className="font-medium">
                              🔧 {t(reminderTypeKey(r.type))}
                            </span>
                            <span className="flex shrink-0 gap-2">
                              <form action={sendReminderAction}>
                                <input
                                  type="hidden"
                                  name="reminderId"
                                  value={r.id}
                                />
                                <button className={BTN_PRIMARY}>
                                  {t("remindersSendToCustomer")}
                                </button>
                              </form>
                              <form action={cancelReminderAction}>
                                <input
                                  type="hidden"
                                  name="reminderId"
                                  value={r.id}
                                />
                                <button className={BTN}>
                                  {t("cancelReminderBtn")}
                                </button>
                              </form>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      ) : null}

      {/* Other months with reminders — collapsible 'jump here' rows
          using native <details>/<summary> (no JS). Each summary line
          is a Link rather than a button so the advisor can SHIFT-click
          to open in a new tab. */}
      {otherMonthList.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
            {t("remindersOtherMonths")}
          </h2>
          <ul className="flex flex-col gap-1">
            {otherMonthList.map((m) => (
              <li key={m.key}>
                <Link
                  href={`/advisor/reminders?month=${m.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-black/10 px-3 py-2 text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                >
                  <span className="font-medium">{m.label}</span>
                  <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-semibold tabular-nums text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                    {m.count}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
