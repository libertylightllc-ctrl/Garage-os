import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { eodBucket, EOD_BUCKETS, type EodBucket } from "@/lib/eod";
import { nudgeCollectionAction } from "@/app/actions/jobs";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";

export const dynamic ="force-dynamic";

const bucketKey = (b: EodBucket): MessageKey => (`eod_${b}` as MessageKey);

export default async function EndOfDay() {
  const session = await requireRole("ADVISOR");
  const t = await getT();

  const jobs = await prisma.jobCard.findMany({
    where: { garageId: session.user.garageId, status: { notIn: ["DELIVERED","CANCELLED"] } },
    include: { vehicle: { include: { customer: true } } },
    orderBy: { updatedAt:"desc"},
  });

  const grouped = new Map<EodBucket, typeof jobs>();
  for (const j of jobs) {
    const b = eodBucket(j.status, j.holdReason);
    if (!grouped.has(b)) grouped.set(b, []);
    grouped.get(b)!.push(j);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs"/>
      <div>
        <Link href="/advisor" className="text-sm text-text-mute hover:underline">
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("eodTitle")}</h1>
        <p className="text-sm text-text-mute">{t("eodIntro")}</p>
      </div>

      {jobs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
          {t("eodEmpty")}
        </p>
      ) : null}

      {EOD_BUCKETS.filter((b) => grouped.has(b)).map((b) => (
        <div key={b}>
          <h2 className="mb-2 text-sm font-medium">
            {t(bucketKey(b))} <span className="text-text-mute">({grouped.get(b)!.length})</span>
          </h2>
          <ul className="flex flex-col gap-1">
            {grouped.get(b)!.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm"
              >
                <Link href={`/advisor/jobs/${j.id}`} className="hover:underline">
                  <span className="font-medium">
                    {j.vehicle.make} {j.vehicle.model}
                  </span>
                  <span className="ms-2 text-text-mute">
                    {j.vehicle.plate} · {j.vehicle.customer.name}
                  </span>
                </Link>
                {b ==="READY"? (
                  <form action={nudgeCollectionAction}>
                    <input type="hidden" name="jobId" value={j.id} />
                    <button className="shrink-0 inline-flex h-8 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-text hover:bg-surface-2 transition-colors transition-colors">
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
