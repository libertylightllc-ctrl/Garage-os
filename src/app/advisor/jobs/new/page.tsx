import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { createJobCardAction } from "@/app/actions/jobs";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

export default async function NewJobCard() {
  const session = await requireRole("ADVISOR");
  const t = await getT();

  const [vehicles, techs] = await Promise.all([
    prisma.vehicle.findMany({
      where: { customer: { garageId: session.user.garageId } },
      include: { customer: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({
      where: { garageId: session.user.garageId, role: "TECH" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <div>
        <Link href="/advisor" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("newJobTitle")}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("pickVehicle")}</p>
      </div>

      {vehicles.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-zinc-500 dark:border-white/20 dark:text-zinc-400">
          {t("noVehicles")}
        </p>
      ) : (
        <form action={createJobCardAction} className="flex flex-col gap-2">
          <label className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("assignTo")}
            <select
              name="assignedToId"
              defaultValue=""
              className="mt-1 block w-full rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            >
              <option value="">{t("unassigned")}</option>
              {techs.map((tech) => (
                <option key={tech.id} value={tech.id}>
                  {tech.name}
                </option>
              ))}
            </select>
          </label>
          {vehicles.map((v) => (
            <button
              key={v.id}
              type="submit"
              name="vehicleId"
              value={v.id}
              className="flex items-center justify-between rounded-lg border border-black/10 p-4 text-left hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
            >
              <span>
                <span className="block font-medium">
                  {v.make} {v.model}
                  <span className="ml-2 text-sm text-zinc-500 dark:text-zinc-400">{v.plate}</span>
                </span>
                <span className="block text-sm text-zinc-500 dark:text-zinc-400">
                  {v.customer.name}
                </span>
              </span>
              <span className="text-sm font-medium">{t("start")}</span>
            </button>
          ))}
        </form>
      )}
    </main>
  );
}
