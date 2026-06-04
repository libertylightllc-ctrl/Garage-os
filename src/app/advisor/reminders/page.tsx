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
  "rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10";
const BTN_PRIMARY = "rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black";

type T = (k: MessageKey) => string;

interface RowData {
  id: string;
  type: string;
  status: string;
  dueAt: Date;
  sentAt: Date | null;
  vehicle: { make: string; model: string; plate: string; customer: { name: string } };
}

function ReminderRow({ r, t, children }: { r: RowData; t: T; children?: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
      <span>
        <span className="font-medium">🔧 {t(reminderTypeKey(r.type))}</span>
        <span className="ms-2 text-zinc-500 dark:text-zinc-400">
          {r.vehicle.make} {r.vehicle.model} · {r.vehicle.plate} · {r.vehicle.customer.name}
        </span>
        <span className="ms-2 text-xs text-zinc-400">
          {r.status === "SENT"
            ? `${t("sentOn")} ${r.sentAt ? day(r.sentAt) : ""}`
            : `${t("dueOn")} ${day(r.dueAt)}`}
        </span>
      </span>
      {children ? <span className="flex shrink-0 gap-2">{children}</span> : null}
    </li>
  );
}

export default async function RemindersQueue() {
  const session = await requireRole("ADVISOR");
  const t = await getT();
  const now = new Date();

  const reminders = await prisma.reminder.findMany({
    where: { garageId: session.user.garageId, status: { in: ["SCHEDULED", "SENT"] } },
    include: { vehicle: { include: { customer: true } } },
    orderBy: { dueAt: "asc" },
  });

  const due = reminders.filter((r) => r.status === "SCHEDULED" && r.dueAt.getTime() <= now.getTime());
  const upcoming = reminders.filter((r) => r.status === "SCHEDULED" && r.dueAt.getTime() > now.getTime());
  const sent = reminders.filter((r) => r.status === "SENT");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="reminders" />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t("remindersTitle")}</h1>
        {due.length > 0 ? (
          <form action={sendDueRemindersAction}>
            <button className={BTN_PRIMARY}>{t("sendDueNow")}</button>
          </form>
        ) : null}
      </div>

      {reminders.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("noReminders")}</p>
      ) : null}

      {due.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">
            {t("dueNow")} <span className="text-zinc-400">({due.length})</span>
          </h2>
          <ul className="flex flex-col gap-1">
            {due.map((r) => (
              <ReminderRow key={r.id} r={r} t={t}>
                <form action={sendReminderAction}>
                  <input type="hidden" name="reminderId" value={r.id} />
                  <button className={BTN_PRIMARY}>{t("sendReminderBtn")}</button>
                </form>
                <form action={cancelReminderAction}>
                  <input type="hidden" name="reminderId" value={r.id} />
                  <button className={BTN}>{t("cancelReminderBtn")}</button>
                </form>
              </ReminderRow>
            ))}
          </ul>
        </div>
      ) : null}

      {upcoming.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">
            {t("upcoming")} <span className="text-zinc-400">({upcoming.length})</span>
          </h2>
          <ul className="flex flex-col gap-1">
            {upcoming.map((r) => (
              <ReminderRow key={r.id} r={r} t={t}>
                <form action={cancelReminderAction}>
                  <input type="hidden" name="reminderId" value={r.id} />
                  <button className={BTN}>{t("cancelReminderBtn")}</button>
                </form>
              </ReminderRow>
            ))}
          </ul>
        </div>
      ) : null}

      {sent.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">
            {t("sentTab")} <span className="text-zinc-400">({sent.length})</span>
          </h2>
          <ul className="flex flex-col gap-1">
            {sent.map((r) => (
              <ReminderRow key={r.id} r={r} t={t} />
            ))}
          </ul>
        </div>
      ) : null}
    </main>
  );
}
