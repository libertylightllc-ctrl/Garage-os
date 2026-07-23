import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin-auth";
import {
  getGarageOverview,
  getGarageDataUsage,
  getGarageActivity,
  getGarageBusinessMetrics,
} from "@/lib/admin-garage-detail";
import { fmtDate, fmtDateTime, countryToTimeZone } from "@/lib/format-datetime";

// Phase 3 per-shop detail page. Three sections:
//   1. DATA USAGE — row counts per table, file/storage counts
//   2. ACTIVITY/ENGAGEMENT — last-active, idle days, per-user last login
//   3. BUSINESS METRICS — revenue, jobs, AI usage (reuses owner-metrics)
//
// Tenant safety:
//   - requireAdmin runs first and gates the whole page (404 for non-admins).
//   - It also targets this garage on the audit row, so the per-shop
//     audit query can later show "who looked at us, when."
//   - All data comes from admin-garage-detail.ts; that file's functions
//     take an AdminContext as their first arg, so this is the only
//     place those functions can be called from — type-level proof.
//
// Layout is plain English, like /admin/garages — admin surface is
// English-only by design (operator-only, not customer-facing).

export const dynamic = "force-dynamic";

export default async function AdminGarageDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = await requireAdmin({
    pageView: "/admin/garages/[id]",
    targetType: "Garage",
    targetId: id,
    targetGarageId: id,
  });

  // After requireAdmin: load the garage. If the id doesn't exist (admin
  // pasted a stale link, or somebody is probing), 404. The audit row
  // for THIS request is already written by requireAdmin above — so the
  // probe is captured even though we send 404.
  const overview = await getGarageOverview(admin, id);
  if (!overview) notFound();
  // Admin surface is English-only per file header comment, so hard-
  // wire locale to "en". Every timestamp on this page is about THIS
  // garage, so it renders in THIS garage's timezone (Deira Central
  // Motors' timestamps → Asia/Dubai; a KSA garage's → Asia/Riyadh).
  const tz = countryToTimeZone(overview.country);

  const [usage, activity, metrics] = await Promise.all([
    getGarageDataUsage(admin, id),
    getGarageActivity(admin, id),
    getGarageBusinessMetrics(admin, id),
  ]);

  const aed = (n: number) =>
    new Intl.NumberFormat("en-AE", {
      style: "currency",
      currency: "AED",
      maximumFractionDigits: 2,
    }).format(n);

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          <Link href="/admin/garages" className="underline-offset-2 hover:underline">
            ← All garages
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{overview.name}</h1>
        <p className="text-sm text-muted-foreground">
          {overview.country} · created {fmtDate(overview.createdAt, "en", tz)}
          {overview.trn ? ` · TRN ${overview.trn}` : ""}
          {" · "}
          {overview.isPilot ? (
            <span className="rounded-full bg-warning-50 px-2 py-0.5 text-xs font-medium text-warning-700">
              Pilot
            </span>
          ) : (
            <span className="rounded-full bg-success-50 px-2 py-0.5 text-xs font-medium text-success-700">
              Paid
            </span>
          )}
        </p>
        <p className="text-sm">
          Owner:{" "}
          {overview.ownerEmail ? (
            <>
              {overview.ownerName ?? "—"} (<span className="font-mono">{overview.ownerEmail}</span>)
            </>
          ) : (
            <span className="text-muted-foreground">no owner user</span>
          )}
        </p>
      </header>

      {/* DATA USAGE */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight">Data usage</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {usage.rowCounts.map((r) => (
            <div
              key={r.table}
              className="rounded-lg border border-border bg-background px-3 py-2"
            >
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {r.table}
              </div>
              <div className="tabular-nums text-lg font-medium">{r.n}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {usage.totalRows} rows in app tables · {usage.uploadedFiles.photos}{" "}
          photo{usage.uploadedFiles.photos === 1 ? "" : "s"} ·{" "}
          {usage.uploadedFiles.voiceNotes} voice note
          {usage.uploadedFiles.voiceNotes === 1 ? "" : "s"} ·{" "}
          {usage.uploadedFiles.logo ? "logo uploaded" : "no logo"}
        </p>
      </section>

      {/* ACTIVITY */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">Activity</h2>
          {activity.isQuiet ? (
            <span className="rounded-full bg-danger-50 px-2 py-0.5 text-xs font-medium text-danger-700">
              Quiet ({activity.daysIdle} days idle)
            </span>
          ) : activity.lastActiveAt === null ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              Never active
            </span>
          ) : (
            <span className="rounded-full bg-success-50 px-2 py-0.5 text-xs font-medium text-success-700">
              Active
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Last activity:{" "}
          <span className="font-mono">
            {activity.lastActiveAt
              ? fmtDateTime(activity.lastActiveAt, "en", tz)
              : "—"}
          </span>
          {activity.daysIdle !== null ? ` · ${activity.daysIdle} day${activity.daysIdle === 1 ? "" : "s"} ago` : ""}
        </p>
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Last login</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {activity.users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-2 font-medium">{u.name}</td>
                  <td className="px-4 py-2 font-mono text-muted-foreground">{u.email}</td>
                  <td className="px-4 py-2">{u.role}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {fmtDate(u.createdAt, "en", tz)}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {u.lastLoginAt ? fmtDateTime(u.lastLoginAt, "en", tz) : "—"}
                  </td>
                </tr>
              ))}
              {activity.users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    No staff users.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* BUSINESS METRICS */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight">Business metrics (this month)</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          <Stat label="Revenue (mo)" value={aed(metrics.revenueMonth)} />
          <Stat label="Profit (mo)" value={aed(metrics.profitMonth)} />
          <Stat label="Cars today" value={String(metrics.carsToday)} />
          <Stat
            label="Week vs last"
            value={`${metrics.weekTrend.thisWeek} / ${metrics.weekTrend.lastWeek}`}
            sub={`Δ ${metrics.weekTrend.delta >= 0 ? "+" : ""}${metrics.weekTrend.delta}`}
          />
          <Stat
            label="AI events (mo)"
            value={String(metrics.aiUsage.events)}
            sub={`$${metrics.aiUsage.costUsd.toFixed(2)}`}
          />
          <Stat
            label="Intake accept"
            value={
              metrics.intakeAcceptance.rate !== null
                ? `${Math.round(metrics.intakeAcceptance.rate * 100)}%`
                : "—"
            }
            sub={`${metrics.intakeAcceptance.confirmed}✓ / ${metrics.intakeAcceptance.rejected}✗`}
          />
          <Stat
            label="Avg confirm"
            value={
              metrics.avgConfirmMinutes !== null
                ? `${metrics.avgConfirmMinutes.toFixed(0)} min`
                : "—"
            }
          />
          <Stat
            label="Inventory low"
            value={`${metrics.inventoryHealth.low} / ${metrics.inventoryHealth.total}`}
          />
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Read-only. Numbers come from the same owner-metrics module the owner sees on their own dashboard.
      </p>
    </main>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="tabular-nums text-lg font-medium">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
