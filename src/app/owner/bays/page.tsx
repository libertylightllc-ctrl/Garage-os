import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { addBayAction, removeBayAction } from "@/app/actions/onboarding";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";

export const dynamic ="force-dynamic";

const field ="rounded-md border border-border bg-transparent px-2 py-1 text-sm";

export default async function BaysPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const { error } = await searchParams;
  const garageId = session.user.garageId;

  const bays = await prisma.bay.findMany({ where: { garageId }, orderBy: { name:"asc"} });
  // How many bays are currently occupied by an active car.
  const inUse = await prisma.jobCard.count({
    where: { garageId, bayId: { not: null }, status: { notIn: ["DELIVERED","CANCELLED"] } },
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="bays"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("baysTitle")}</h1>
      <p className="text-sm text-text-mute">{t("baysIntro")}</p>

      <div className="rounded-xl border border-border p-3 text-sm">
        <span className="font-medium">
          {inUse} / {bays.length}
        </span>{""}
        <span className="text-text-mute">{t("baysInUse")}</span>
      </div>

      {error ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {error ==="exists"? t("bayExists") : t("branchError")}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {bays.map((b) => (
          <li
            key={b.id}
            className="flex items-center justify-between rounded-xl border border-border p-3 text-sm"
          >
            <span className="font-medium">🛠️ {b.name}</span>
            <form action={removeBayAction}>
              <input type="hidden" name="bayId" value={b.id} />
              <button className="text-xs text-danger-700 hover:underline">{t("remove")}</button>
            </form>
          </li>
        ))}
      </ul>

      <form action={addBayAction} className="flex gap-2 rounded-xl border border-border p-4">
        <input name="name" placeholder={t("bayNamePh")} required className={`${field} flex-1`} />
        <Button>{t("addBay")}</Button>
      </form>
    </main>
  );
}
