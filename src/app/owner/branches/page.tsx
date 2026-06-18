import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { listBranches } from "@/lib/branches";
import { addBranchAction } from "@/app/actions/onboarding";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

const field ="rounded-md border border-border bg-transparent px-2 py-1 text-sm";

export default async function BranchesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const { error } = await searchParams;

  const branches = await listBranches(session.user.garageId);
  // Staff counts per branch (each branch has its own team).
  const counts = await prisma.user.groupBy({
    by: ["garageId"],
    where: { garageId: { in: branches.map((b) => b.id) } },
    _count: { _all: true },
  });
  const staffCount = new Map(counts.map((c) => [c.garageId, c._count._all]));

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="branches"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("branchesTitle")}</h1>
      <p className="text-sm text-text-mute">{t("branchesIntro")}</p>

      {error ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {t("branchError")}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {branches.map((b) => (
          <li
            key={b.id}
            className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
          >
            <span>
              <span className="font-medium">{b.name}</span>
              {b.isRoot ? (
                <span className="ms-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs">
                  {t("branchMainTag")}
                </span>
              ) : null}
            </span>
            <span className="text-xs text-text-mute">
              {staffCount.get(b.id) ?? 0} · {b.isPilot ?"🟢":""}
            </span>
          </li>
        ))}
      </ul>

      <form action={addBranchAction} className="flex gap-2 rounded-xl border border-border p-4">
        <input name="name" placeholder={t("branchName")} required className={`${field} flex-1`} />
        <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
          {t("addBranch")}
        </button>
      </form>
    </main>
  );
}
