import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { eodBucket, EOD_BUCKETS, type EodBucket } from "@/lib/eod";
import { nudgeCollectionAction } from "@/app/actions/jobs";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";

export const dynamic = "force-dynamic";

const bucketKey = (b: EodBucket): MessageKey => (`eod_${b}` as MessageKey);

export default async function EndOfDay() {
  const session = await requireRole("ADVISOR");
  const t = await getT();

  const jobs = await prisma.jobCard.findMany({
    where: { garageId: session.user.garageId, status: { notIn: ["DELIVERED", "CANCELLED"] } },
    include: { vehicle: { include: { customer: true } } },
    orderBy: { updatedAt: "desc" },
  });

  const grouped = new Map<EodBucket, typeof jobs>();
  for (const j of jobs) {
    const b = eodBucket(j.status, j.holdReason);
    if (!grouped.has(b)) grouped.set(b, []);
    grouped.get(b)!.push(j);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <div>
        <Link href="/advisor" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("eodTitle")}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("eodIntro")}</p>
      </div>

      {jobs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-zinc-500 dark:border-white/20 dark:text-zinc-400">
          {t("eodEmpty")}
        </p>
      ) : null}

      {EOD_BUCKETS.filter((b) => grouped.has(b)).map((b) => (
        <div key={b}>
          <h2 className="mb-2 text-sm font-medium">
            {t(bucketKey(b))} <span className="text-zinc-400">({grouped.get(b)!.length})</span>
          </h2>
          <ul className="flex flex-col gap-1">
            {grouped.get(b)!.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
              >
                <Link href={`/advisor/jobs/${j.id}`} className="hover:underline">
                  <span className="font-medium">
                    {j.vehicle.make} {j.vehicle.model}
                  </span>
                  <span className="ms-2 text-zinc-500 dark:text-zinc-400">
                    {j.vehicle.plate} · {j.vehicle.customer.name}
                  </span>
                </Link>
                {b === "READY" ? (
                  <form action={nudgeCollectionAction}>
                    <input type="hidden" name="jobId" value={j.id} />
                    <button className="shrink-0 rounded-md border border-black/15 px-3 py-1 text-xs font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
                      {t("nudgeCollect")}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </main>
  );
}
