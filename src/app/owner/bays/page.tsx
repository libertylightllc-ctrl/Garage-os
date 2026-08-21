import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
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
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const { error } = await searchParams;
  const garageId = session.user.garageId;

  // AR 2026-08-21 — include the active JobCard(s) parked in each
  // bay so the operator can see WHICH car is where, not just how
  // many bays are occupied. Two active jobs on one bay is a data
  // glitch (no unique constraint on Bay ↔ active JobCard); we
  // render both with a warning marker rather than silently pick
  // one.
  const bays = await prisma.bay.findMany({
    where: { garageId },
    orderBy: { name: "asc" },
    include: {
      jobCards: {
        where: { status: { notIn: ["DELIVERED", "CANCELLED"] } },
        select: {
          id: true, number: true, status: true,
          vehicle: { select: { make: true, model: true, plate: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  const inUse = bays.filter((b) => b.jobCards.length > 0).length;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 lg:max-w-5xl xl:max-w-6xl">
      <AppNav role={session.user.role as "OWNER" | "MASTER"} active="bays"/>
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

      {/* Two-column on lg+: existing bays on the left, add-bay form on
          the right. Below lg the form drops below the list (same source
          order — no markup move, just a grid wrapper). Remove buttons
          stay inline on each list row. */}
      <div className="lg:grid lg:grid-cols-3 lg:gap-6 lg:items-start">
      <ul className="flex flex-col gap-1 lg:col-span-2">
        {bays.map((b) => {
          const occupancy = b.jobCards.length;
          return (
            <li
              key={b.id}
              className="flex flex-col gap-1 rounded-xl border border-border p-3 text-sm"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">🛠️ {b.name}</span>
                <form action={removeBayAction}>
                  <input type="hidden" name="bayId" value={b.id} />
                  <button className="text-xs text-danger-700 hover:underline">{t("remove")}</button>
                </form>
              </div>
              {occupancy === 0 ? (
                <span className="text-xs text-text-mute">{t("bayEmpty")}</span>
              ) : (
                <ul className="flex flex-col gap-0.5 text-xs text-text-mute">
                  {occupancy > 1 ? (
                    <li className="text-warning-700 dark:text-warning-500">
                      ⚠ {t("bayMultipleOccupants").replace("{n}", String(occupancy))}
                    </li>
                  ) : null}
                  {b.jobCards.map((jc) => (
                    <li key={jc.id}>
                      <Link href={`/advisor/jobs/${jc.id}`} className="hover:underline">
                        {jc.vehicle.make} {jc.vehicle.model} · {jc.vehicle.plate}
                        {jc.number ? ` · JC-${jc.number}` : ""}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <form action={addBayAction} className="mt-6 flex gap-2 rounded-xl border border-border p-4 lg:mt-0">
        <input name="name" placeholder={t("bayNamePh")} required className={`${field} flex-1`} />
        <Button>{t("addBay")}</Button>
      </form>
      </div>
    </main>
  );
}
