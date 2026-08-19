import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
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
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/confirm-button";

export const dynamic ="force-dynamic";

const day = (d: Date) => d.toISOString().slice(0, 10);

const BTN =
"inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-text hover:bg-surface-2 transition-colors";
const BTN_PRIMARY =
"inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";

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
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,"0")}`;
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
  return `${year}-${String(month).padStart(2,"0")}`;
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
    .join("")
    .toLowerCase();
  return hay.includes(needle);
}

export default async function RemindersQueue({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; month?: string }>;
}) {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
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
    month:"long",
    year:"numeric",
    timeZone:"UTC",
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
      status:"SCHEDULED",
    },
    include: { vehicle: { include: { customer: true } } },
    orderBy: { dueAt:"asc"},
  });

  const filtered = all.filter((r) => matchesFilter(r, q, t));

  // Reminders that fall inside the selected month.
  const inMonth = filtered.filter(
    (r) => r.dueAt >= selStart && r.dueAt <= selEnd,
  );

  // Selected month — vehicle-first rollup. Drop the per-date subgroup
  // (user feedback: cars are the unit, not dates). Inside each vehicle
  // card the reminders still show their dueDate so the advisor knows
  // when each one fires. groupByVehicle already sorts alphabetically;
  // within a vehicle the reminders preserve the DB's dueAt-asc order.
  const monthVehicles = groupByVehicle(inMonth);

  // Other months — same vehicle-rollup shape as the selected month so
  // the advisor reads identical structure top-to-bottom. For each
  // month with ≥1 (filtered) reminder, accumulate per-vehicle counts.
  const otherMonths = new Map<
    string,
    { total: number; byVehicle: Map<string, { vehicle: ReminderRow["vehicle"]; count: number }> }
  >();
  for (const r of filtered) {
    const k = monthKey(r.dueAt);
    if (k === selKey) continue;
    let entry = otherMonths.get(k);
    if (!entry) {
      entry = { total: 0, byVehicle: new Map() };
      otherMonths.set(k, entry);
    }
    entry.total += 1;
    const v = entry.byVehicle.get(r.vehicle.id);
    if (v) v.count += 1;
    else entry.byVehicle.set(r.vehicle.id, { vehicle: r.vehicle, count: 1 });
  }
  const otherMonthList = Array.from(otherMonths.entries())
    .map(([key, { total, byVehicle }]) => {
      const [yStr, moStr] = key.split("-");
      const y = Number(yStr);
      const mo = Number(moStr);
      const label = monthStartUtc(y, mo).toLocaleDateString(locale, {
        month:"long",
        year:"numeric",
        timeZone:"UTC",
      });
      // Sort vehicles inside the month by count desc, then make/model
      // asc — busy vehicles bubble to the top of each bullet list.
      const vehicleBullets = Array.from(byVehicle.values()).sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return `${a.vehicle.make} ${a.vehicle.model}`.localeCompare(
          `${b.vehicle.make} ${b.vehicle.model}`,
        );
      });
      return { key, year: y, month: mo, label, total, vehicleBullets };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  // Whether any reminders in the selected month are due on or before
  // today — drives the 'Send to all overdue this month →' bulk button.
  const hasOverdueInMonth = inMonth.some((r) => r.dueAt <= now);
  // AR 2026-08-19 — Send-in-view fix. The bulk-send button used to
  // post an empty form and the action re-queried ALL SCHEDULED
  // reminders garage-wide, ignoring the filter + month view (INC
  // 2026-08-18: filtering to one customer, then clicking the button,
  // sent to every overdue customer's phone). The visible-overdue set
  // is computed here and passed via hidden inputs so the action can
  // only act on what the operator sees.
  const overdueInView = inMonth.filter((r) => r.dueAt <= now);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="reminders"/>
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
          className="min-w-40 flex-1 h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
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
            ‹ prev | big month label | next › | native <input type=month>
          Prev/next are plain Links → server re-renders with the new
          month. The native picker uses a GET form so a date jump
          works without JS too. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
        <div className="flex items-center gap-2">
          <Link
            href={`/advisor/reminders?month=${monthKeyFromYM(prevYM.year, prevYM.month)}${q ? `&q=${encodeURIComponent(q)}` :""}`}
            className={BTN}
            aria-label={t("remindersPrevMonth")}
          >
            ‹
          </Link>
          <span className="text-lg font-semibold tabular-nums">{monthLabel}</span>
          <Link
            href={`/advisor/reminders?month=${monthKeyFromYM(nextYM.year, nextYM.month)}${q ? `&q=${encodeURIComponent(q)}` :""}`}
            className={BTN}
            aria-label={t("remindersNextMonth")}
          >
            ›
          </Link>
        </div>
        <form method="get" className="flex items-center gap-2">
          {q ? <input type="hidden" name="q" value={q} /> : null}
          <label className="text-xs text-text-mute">
            {t("remindersJumpToMonth")}
          </label>
          <input
            type="month"
            name="month"
            defaultValue={selKey}
            className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
          />
          <button className={BTN}>{t("remindersFilterApply")}</button>
        </form>
      </div>

      {/* Summary line — 'N reminders · M cars due in August 2026'.
          Reflects the FILTERED count (i.e. respects ?q=), not the raw
          DB total. The '· M cars' clause is hidden when the month is
          empty so '0 reminders due in Nov 2026' still reads cleanly. */}
      <p className="text-sm text-text">
        <span className="font-semibold tabular-nums">{inMonth.length}</span>{""}
        {inMonth.length === 1
          ? t("remindersReminderSingular")
          : t("remindersReminderPlural")}
        {monthVehicles.length > 0 ? (
          <>
            {"·"}
            <span className="font-semibold tabular-nums">
              {monthVehicles.length}
            </span>{""}
            {monthVehicles.length === 1
              ? t("remindersCarSingular")
              : t("remindersCarPlural")}
          </>
        ) : null}{""}
        {t("remindersSummaryDueIn")} {monthLabel}
      </p>

      {/* Empty states — distinguishes 'no data at all' from 'no data
          for this month' so the advisor doesn't think the page is
          broken when they navigate to an empty future month. */}
      {all.length === 0 ? (
        <p className="text-sm text-text-mute">
          {t("noReminders")}
        </p>
      ) : null}
      {all.length > 0 && filtered.length === 0 ? (
        <p className="text-sm text-text-mute">
          {t("remindersFilterNoMatch")}
        </p>
      ) : null}
      {filtered.length > 0 && inMonth.length === 0 ? (
        <p className="text-sm text-text-mute">
          {t("remindersMonthEmpty")}
        </p>
      ) : null}

      {/* Selected-month view — vehicle-first rollup. One card per
          vehicle, count of items on the right, individual reminders
          listed inside with their due date + Send/Cancel actions.
          No per-date subgrouping (cars are the unit; the date is
          still visible per row inside each card). */}
      {inMonth.length > 0 ? (
        <section className="flex flex-col gap-3">
          {overdueInView.length > 0 ? (
            <div className="flex justify-end">
              {/* AR 2026-08-19 — send-in-view only. Hidden inputs
                  carry the exact ids the operator can see (filtered +
                  month-scoped + overdue). The action iterates supplied
                  ids and no longer re-queries the whole overdue book.
                  ConfirmButton shows a native prompt with the count +
                  a warning that WhatsApp receipts are hand-off (rule
                  4). */}
              <form action={sendDueRemindersAction}>
                {overdueInView.map((r) => (
                  <input key={r.id} type="hidden" name="reminderId" value={r.id} />
                ))}
                <ConfirmButton
                  className={BTN_PRIMARY}
                  message={t("remindersBulkSendConfirm").replace(
                    "{n}",
                    String(overdueInView.length),
                  )}
                >
                  {t("remindersBulkSendOverdueN").replace(
                    "{n}",
                    String(overdueInView.length),
                  )}
                </ConfirmButton>
              </form>
            </div>
          ) : null}
          <ul className="flex flex-col gap-2">
            {monthVehicles.map((g) => {
              const earliestDue = g.rs.reduce(
                (min, r) => (r.dueAt < min ? r.dueAt : min),
                g.rs[0].dueAt,
              );
              const overdue = earliestDue <= now;
              return (
                <li
                  key={g.vehicle.id}
                  className={
                  "flex flex-col gap-2 rounded-xl border p-3 text-sm"+
                    (overdue
                      ?"border-danger-500/40 bg-danger-50 dark:border-danger-500/30 dark:bg-danger-500/10"
                      :"border-border")
                  }
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-semibold">
                        {g.vehicle.make} {g.vehicle.model}
                      </span>
                      <span className="ms-2 text-text">
                        {g.vehicle.plate} · {g.vehicle.customer.name}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {overdue ? (
                        <Badge tone="danger" size="pill">
                          {t("remindersBucketOverdue")}
                        </Badge>
                      ) : null}
                      <Badge tone="neutral" size="pill" className="tabular-nums">
                        {g.rs.length}{""}
                        {g.rs.length === 1
                          ? t("remindersReminderSingular")
                          : t("remindersReminderPlural")}
                      </Badge>
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1 ps-2">
                    {g.rs.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-1.5"
                      >
                        <span>
                          <span className="font-medium">
                            🔧 {t(reminderTypeKey(r.type))}
                          </span>
                          <span className="ms-2 text-xs text-text-mute">
                            {t("dueOn")} {day(r.dueAt)}
                          </span>
                        </span>
                        <span className="flex shrink-0 gap-2">
                          <form action={sendReminderAction}>
                            <input type="hidden" name="reminderId" value={r.id} />
                            <button className={BTN_PRIMARY}>
                              {t("remindersSendToCustomer")}
                            </button>
                          </form>
                          <form action={cancelReminderAction}>
                            <input type="hidden" name="reminderId" value={r.id} />
                            <button className={BTN}>
                              {t("cancelReminderBtn")}
                            </button>
                          </form>
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Other months with reminders — one clean row per month.
          Month name on the left, 'N reminders · M cars' on the right.
          The whole row is a Link so the advisor jumps to that month
          for actions; no per-vehicle expansion here (cars are visible
          inside the per-month detail view, so showing them twice would
          double the page length). */}
      {otherMonthList.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-text">
            {t("remindersOtherMonths")}
          </h2>
          <ul className="flex flex-col gap-1">
            {otherMonthList.map((m) => (
              <li key={m.key}>
                <Link
                  href={`/advisor/reminders?month=${m.key}${q ? `&q=${encodeURIComponent(q)}` :""}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-2 transition-colors"
                >
                  <span className="font-medium">{m.label}</span>
                  <span className="text-xs text-text-mute">
                    <span className="tabular-nums font-semibold text-text">
                      {m.total}
                    </span>{""}
                    {m.total === 1
                      ? t("remindersReminderSingular")
                      : t("remindersReminderPlural")}
                    {"·"}
                    <span className="tabular-nums font-semibold text-text">
                      {m.vehicleBullets.length}
                    </span>{""}
                    {m.vehicleBullets.length === 1
                      ? t("remindersCarSingular")
                      : t("remindersCarPlural")}
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
