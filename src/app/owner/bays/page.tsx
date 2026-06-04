import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { addBayAction, removeBayAction } from "@/app/actions/onboarding";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

const field = "rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20";

export default async function BaysPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const { error } = await searchParams;
  const garageId = session.user.garageId;

  const bays = await prisma.bay.findMany({ where: { garageId }, orderBy: { name: "asc" } });
  // How many bays are currently occupied by an active car.
  const inUse = await prisma.jobCard.count({
    where: { garageId, bayId: { not: null }, status: { notIn: ["DELIVERED", "CANCELLED"] } },
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="bays" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("baysTitle")}</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("baysIntro")}</p>

      <div className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
        <span className="font-medium">
          {inUse} / {bays.length}
        </span>{" "}
        <span className="text-zinc-500 dark:text-zinc-400">{t("baysInUse")}</span>
      </div>

      {error ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error === "exists" ? t("bayExists") : t("branchError")}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {bays.map((b) => (
          <li
            key={b.id}
            className="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
          >
            <span className="font-medium">🛠️ {b.name}</span>
            <form action={removeBayAction}>
              <input type="hidden" name="bayId" value={b.id} />
              <button className="text-xs text-red-600 hover:underline">{t("remove")}</button>
            </form>
          </li>
        ))}
      </ul>

      <form action={addBayAction} className="flex gap-2 rounded-lg border border-black/10 p-4 dark:border-white/15">
        <input name="name" placeholder={t("bayNamePh")} required className={`${field} flex-1`} />
        <button className="rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black">
          {t("addBay")}
        </button>
      </form>
    </main>
  );
}
