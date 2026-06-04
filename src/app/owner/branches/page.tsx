import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { listBranches } from "@/lib/branches";
import { addBranchAction } from "@/app/actions/onboarding";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

const field = "rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20";

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
      <AppNav role="OWNER" active="branches" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("branchesTitle")}</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("branchesIntro")}</p>

      {error ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {t("branchError")}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {branches.map((b) => (
          <li
            key={b.id}
            className="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
          >
            <span>
              <span className="font-medium">{b.name}</span>
              {b.isRoot ? (
                <span className="ms-2 rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
                  {t("branchMainTag")}
                </span>
              ) : null}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {staffCount.get(b.id) ?? 0} · {b.isPilot ? "🟢" : ""}
            </span>
          </li>
        ))}
      </ul>

      <form action={addBranchAction} className="flex gap-2 rounded-lg border border-black/10 p-4 dark:border-white/15">
        <input name="name" placeholder={t("branchName")} required className={`${field} flex-1`} />
        <button className="rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black">
          {t("addBranch")}
        </button>
      </form>
    </main>
  );
}
