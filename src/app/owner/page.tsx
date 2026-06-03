import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { signOutAction } from "@/app/actions/auth";
import { classifyIntent, SAMPLE_QUESTIONS, UNKNOWN_REPLY } from "@/lib/copilot";
import {
  revenue,
  profitThisMonth,
  carsToday,
  inventoryHealth,
  weekTrend,
  whoOwes,
  aiUsage,
  intakeAcceptance,
  avgConfirmMinutes,
} from "@/lib/owner-metrics";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

async function answerCopilot(garageId: string, question: string, now: Date): Promise<string> {
  switch (classifyIntent(question)) {
    case "PROFIT_MONTH": {
      const p = await profitThisMonth(garageId, now);
      return `This month's profit is ${money(p)} so far (revenue minus parts cost).`;
    }
    case "WHO_OWES": {
      const rows = await whoOwes(garageId, now);
      if (rows.length === 0) return "Nobody owes you money right now — all invoices are paid. 🟢";
      const total = rows.reduce((s, r) => s + r.balance, 0);
      const list = rows
        .map((r) => `${r.overdue ? "🔴" : "🟡"} ${r.customer}: ${money(r.balance)}`)
        .join("; ");
      return `${rows.length} customer(s) owe ${money(total)} in total — ${list}.`;
    }
    case "WEEK_TREND": {
      const t = await weekTrend(garageId, now);
      const dir = t.delta > 0 ? "up" : t.delta < 0 ? "down" : "flat";
      return `You're ${dir} this week: ${money(t.thisWeek)} vs ${money(t.lastWeek)} last week (${
        t.delta >= 0 ? "+" : ""
      }${money(t.delta)}).`;
    }
    default:
      return UNKNOWN_REPLY;
  }
}

export default async function OwnerHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireRole("OWNER");
  const garageId = session.user.garageId;
  const now = new Date();
  const { q } = await searchParams;

  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const [rev, profit, cars, inv, trend, usage, acceptance, confirmMins] = await Promise.all([
    revenue(garageId, monthFrom),
    profitThisMonth(garageId, now),
    carsToday(garageId, now),
    inventoryHealth(garageId),
    weekTrend(garageId, now),
    aiUsage(garageId, monthFrom),
    intakeAcceptance(garageId),
    avgConfirmMinutes(garageId),
  ]);

  let answer: string | null = null;
  if (q && q.trim()) {
    answer = await answerCopilot(garageId, q, now);
    // Meter the copilot interaction (read-only; answer derived from DB only).
    await prisma.aiEvent.create({
      data: {
        garageId,
        userId: session.user.id,
        kind: "COPILOT",
        model: "copilot-rules",
        sourceType: "OWNER_QUESTION",
        tokensIn: 0,
        tokensOut: 0,
        costEstimate: 0,
        latencyMs: 0,
      },
    });
  }

  const metrics = [
    { icon: "💰", label: "Revenue (mo)", value: money(rev) },
    { icon: "📈", label: "Profit (mo)", value: money(profit) },
    { icon: "🚗", label: "Cars today", value: String(cars) },
    { icon: "⭐", label: "Satisfaction", value: "—" },
    { icon: "📦", label: "Inventory", value: `${inv.low} low / ${inv.total}` },
  ];

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">GarageOS</p>
          <h1 className="text-2xl font-semibold tracking-tight">Owner dashboard</h1>
        </div>
        <form action={signOutAction}>
          <button className="text-xs text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400">
            Sign out
          </button>
        </form>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-xl border border-black/10 p-3 dark:border-white/15">
            <div className="text-2xl">{m.icon}</div>
            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{m.label}</div>
            <div className="text-base font-semibold">{m.value}</div>
          </div>
        ))}
      </div>
      <p className="-mt-3 text-xs text-zinc-400">
        This week: {money(trend.thisWeek)} ({trend.delta >= 0 ? "+" : ""}
        {money(trend.delta)} vs last week). Satisfaction tracking arrives with reviews.
      </p>

      {/* Copilot */}
      <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
        <h2 className="mb-2 text-sm font-medium">Ask the copilot</h2>
        <form method="GET" className="flex gap-2">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="e.g. Who owes us money?"
            className="flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
          />
          <button className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black">
            Ask
          </button>
        </form>
        <div className="mt-2 flex flex-wrap gap-2">
          {SAMPLE_QUESTIONS.map((s) => (
            <Link
              key={s}
              href={`/owner?q=${encodeURIComponent(s)}`}
              className="rounded-full border border-black/10 px-3 py-1 text-xs text-zinc-600 hover:bg-black/5 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/10"
            >
              {s}
            </Link>
          ))}
        </div>
        {answer ? (
          <p className="mt-3 rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">{answer}</p>
        ) : null}
        <p className="mt-2 text-xs text-zinc-400">Read-only · scoped to your garage.</p>
      </div>

      {/* Pilot instrumentation + AI margin meter */}
      <div className="rounded-xl border border-black/10 p-4 text-sm dark:border-white/15">
        <h2 className="mb-2 text-sm font-medium">Pilot metrics &amp; AI usage</h2>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
          <li>
            Intake acceptance:{" "}
            <span className="font-medium">
              {acceptance.rate === null ? "—" : `${Math.round(acceptance.rate * 100)}%`}
            </span>{" "}
            <span className="text-zinc-400">({acceptance.confirmed}/{acceptance.confirmed + acceptance.rejected})</span>
          </li>
          <li>
            Avg booking→confirm:{" "}
            <span className="font-medium">{confirmMins === null ? "—" : `${confirmMins} min`}</span>
          </li>
          <li>
            AI calls (mo): <span className="font-medium">{usage.events}</span>
          </li>
          <li>
            AI cost (mo): <span className="font-medium">${usage.costUsd.toFixed(4)}</span>
          </li>
        </ul>
        <p className="mt-2 text-xs text-zinc-400">
          AI cost is metered per call (AiEvent) so Layer-2 usage can’t silently outrun the subscription.
        </p>
      </div>
    </main>
  );
}
