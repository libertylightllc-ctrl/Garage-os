import Link from "next/link";
import { signOut } from "@/auth";
import { requireAdmin } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";

// Phase 1 admin surface: cross-garage read-only list. Requires admin.
// Every other /admin/* page must start with the same requireAdmin()
// call — that's the gate. No client component, no data fetched in any
// other path: server-side rendering means there's no API to call
// without going through this page handler.
async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/admin/login" });
}

export default async function AdminGaragesPage() {
  const admin = await requireAdmin({ pageView: "/admin/garages" });

  // Pull everything in one query — Phase 1 is read-only and the list
  // is small (~10s of garages). _count is server-side aggregation, so
  // no N+1.
  const garages = await prisma.garage.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { users: true, jobCards: true } },
      users: {
        where: { role: "OWNER" },
        select: { email: true },
        take: 1,
      },
    },
  });

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Operator
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">All garages</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/admin/garages/new"
            className="rounded-md border border-border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            + New garage
          </Link>
          <form action={signOutAction}>
            <span className="mr-3 text-xs text-muted-foreground">
              {admin.email}
            </span>
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-1.5 text-xs"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Garage</th>
              <th className="px-4 py-3">Owner email</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Users</th>
              <th className="px-4 py-3 text-right">Jobs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {garages.map((g) => (
              <tr key={g.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">
                  <Link
                    href={`/admin/garages/${g.id}`}
                    className="hover:underline"
                  >
                    {g.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {g.users[0]?.email ?? "—"}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {/* Per-row per-garage timezone — admin sees each shop's
                      LOCAL "created" date, not UTC. Deira Central Motors
                      (UAE) renders in Asia/Dubai; a KSA garage would
                      render in Asia/Riyadh. Country from the row itself. */}
                  {fmtDate(g.createdAt, "en", countryToTimeZone(g.country))}
                </td>
                <td className="px-4 py-3">
                  {g.isPilot ? (
                    <span className="rounded-full bg-warning-50 px-2 py-0.5 text-xs font-medium text-warning-700">
                      Pilot
                    </span>
                  ) : (
                    <span className="rounded-full bg-success-50 px-2 py-0.5 text-xs font-medium text-success-700">
                      Paid
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {g._count.users}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {g._count.jobCards}
                </td>
              </tr>
            ))}
            {garages.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-sm text-muted-foreground"
                >
                  No garages yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Read-only. Operator session expires 4 hours after sign-in.
      </p>
    </main>
  );
}
