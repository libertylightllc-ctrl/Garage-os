import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { reminderTypeKey } from "@/i18n/config";
import type { MessageKey } from "@/i18n/config";
import { getT } from "@/i18n/server";
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

// ─── Urgency buckets ────────────────────────────────────────────
// Driven by dueAt vs. now. Counts and section colours are derived
// from this single shape — change the cutoffs here and every header
// updates. No reminder-domain logic changes; this is pure UI math.
type Bucket = "overdue" | "due_soon" | "due_month" | "upcoming";
const BUCKET_META: Record<
  Bucket,
  { titleKey: MessageKey; chip: string; badge: string }
> = {
  overdue: {
    titleKey: "remindersBucketOverdue",
    chip:
      "rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900 dark:bg-red-950/60 dark:text-red-200",
    badge:
      "border-red-500/40 bg-red-50 dark:border-red-700/40 dark:bg-red-950/30",
  },
  due_soon: {
    titleKey: "remindersBucketDueSoon",
    chip:
      "rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-900 dark:bg-orange-950/60 dark:text-orange-200",
    badge:
      "border-orange-500/40 bg-orange-50 dark:border-orange-700/40 dark:bg-orange-950/30",
  },
  due_month: {
    titleKey: "remindersBucketDueMonth",
    chip:
      "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
    badge:
      "border-amber-500/40 bg-amber-50 dark:border-amber-700/40 dark:bg-amber-950/30",
  },
  upcoming: {
    titleKey: "remindersBucketUpcoming",
    chip:
      "rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
    badge:
      "border-black/10 bg-zinc-50 dark:border-white/15 dark:bg-zinc-900/40",
  },
};
const BUCKET_ORDER: Bucket[] = [
  "overdue",
  "due_soon",
  "due_month",
  "upcoming",
];

function classifyBucket(dueAt: Date, now: Date): Bucket {
  const ms = dueAt.getTime() - now.getTime();
  const days = ms / (1000 * 60 * 60 * 24);
  if (days < 0) return "overdue";
  if (days <= 7) return "due_soon";
  if (days <= 30) return "due_month";
  return "upcoming";
}

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

// Group reminders within a bucket by vehicleId so the cashier sees
// 'GMC Yukon — Oil + Battery + Brakes' as one card instead of three
// scattered rows. Vehicle order = earliest dueAt within the group, so
// the most urgent vehicle bubbles to the top of the bucket.
function groupByVehicle(rs: ReminderRow[]) {
  const map = new Map<string, { vehicle: ReminderRow["vehicle"]; rs: ReminderRow[] }>();
  for (const r of rs) {
    const g = map.get(r.vehicle.id);
    if (g) g.rs.push(r);
    else map.set(r.vehicle.id, { vehicle: r.vehicle, rs: [r] });
  }
  return Array.from(map.values()).sort((a, b) => {
    const aMin = Math.min(...a.rs.map((r) => r.dueAt.getTime()));
    const bMin = Math.min(...b.rs.map((r) => r.dueAt.getTime()));
    return aMin - bMin;
  });
}

// Cheap server-side text filter: matches against service type
// (translated), vehicle make/model/plate, and customer name. Empty
// query passes everything through.
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
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireRole("ADVISOR");
  const t = await getT();
  const now = new Date();
  const { q: rawQ } = await searchParams;
  const q = (rawQ ?? "").trim();

  // Pull every active reminder for the garage. SENT rows stay on the
  // page (audit row at the bottom). CANCELLED rows are filtered out
  // at the DB level so the page never gets noisy with dismissed ones.
  const all = await prisma.reminder.findMany({
    where: {
      garageId: session.user.garageId,
      status: { in: ["SCHEDULED", "SENT"] },
    },
    include: { vehicle: { include: { customer: true } } },
    orderBy: { dueAt: "asc" },
  });

  // Apply the text filter once, up front. Every bucket below works off
  // the filtered set — the urgency counts shown in headers therefore
  // reflect 'matching this filter', not 'total in DB'.
  const filtered = all.filter((r) => matchesFilter(r, q, t));

  const scheduled = filtered.filter((r) => r.status === "SCHEDULED");
  const sent = filtered.filter((r) => r.status === "SENT");

  // Partition scheduled reminders into the 4 urgency buckets.
  const buckets: Record<Bucket, ReminderRow[]> = {
    overdue: [],
    due_soon: [],
    due_month: [],
    upcoming: [],
  };
  for (const r of scheduled) {
    buckets[classifyBucket(r.dueAt, now)].push(r);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="reminders" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("remindersTitle")}</h1>

      {/* Filter bar — server-side, URL-driven. Plain GET form so the
          URL is bookmarkable / back-button friendly without JS. A
          'Clear' link shows up when q is set so the user can wipe the
          filter without manually editing the URL. */}
      <form method="get" className="flex flex-wrap gap-2">
        <input
          name="q"
          type="search"
          defaultValue={q}
          placeholder={t("remindersFilterPlaceholder")}
          className="min-w-40 flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
        />
        <button className={BTN}>{t("remindersFilterApply")}</button>
        {q ? (
          <Link href="/advisor/reminders" className={BTN}>
            {t("remindersFilterClear")}
          </Link>
        ) : null}
      </form>

      {all.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("noReminders")}</p>
      ) : null}
      {all.length > 0 && filtered.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("remindersFilterNoMatch")}
        </p>
      ) : null}

      {/* Urgency sections — render in fixed order so the cashier's eye
          falls on Overdue first every time. Empty buckets collapse
          (hidden) so the page stays compact when most reminders are
          far out. */}
      {BUCKET_ORDER.map((b) => {
        const list = buckets[b];
        if (list.length === 0) return null;
        const meta = BUCKET_META[b];
        const groups = groupByVehicle(list);
        return (
          <section key={b}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-medium">
                <span className={meta.chip}>{list.length}</span>
                {t(meta.titleKey)}
              </h2>
              {/* Bulk action: only on Overdue — that's the bucket
                  where 'send everyone right now' is actually
                  actionable. sendDueRemindersAction already targets
                  dueAt <= now, which is exactly the overdue + due-
                  today set. */}
              {b === "overdue" ? (
                <form action={sendDueRemindersAction}>
                  <button className={BTN_PRIMARY}>
                    {t("remindersBulkSendOverdue")}
                  </button>
                </form>
              ) : null}
            </div>
            <ul className={`flex flex-col gap-2`}>
              {groups.map((g) => (
                <li
                  key={g.vehicle.id}
                  className={`flex flex-col gap-2 rounded-lg border p-3 text-sm ${meta.badge}`}
                >
                  {/* Vehicle header — make + model + plate +
                      customer + count of items in this bucket. The
                      customer name is the routing key for the mock
                      WhatsApp send, so showing it on the header
                      tells the cashier 'this is who will hear from
                      me if I tap Send'. */}
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
                        <span>
                          <span className="font-medium">
                            🔧 {t(reminderTypeKey(r.type))}
                          </span>
                          <span className="ms-2 text-xs text-zinc-500 dark:text-zinc-400">
                            {t("dueOn")} {day(r.dueAt)}
                          </span>
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
          </section>
        );
      })}

      {/* Sent — audit row at the bottom so the cashier can see
          recently-sent reminders without them crowding the actionable
          urgency buckets. No per-row actions (already sent). */}
      {sent.length > 0 ? (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
              {sent.length}
            </span>
            {t("sentTab")}
          </h2>
          <ul className="flex flex-col gap-1">
            {sent.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
              >
                <span>
                  <span className="font-medium">
                    🔧 {t(reminderTypeKey(r.type))}
                  </span>
                  <span className="ms-2 text-zinc-500 dark:text-zinc-400">
                    {r.vehicle.make} {r.vehicle.model} · {r.vehicle.plate} ·{" "}
                    {r.vehicle.customer.name}
                  </span>
                  <span className="ms-2 text-xs text-zinc-400">
                    {t("sentOn")} {r.sentAt ? day(r.sentAt) : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
