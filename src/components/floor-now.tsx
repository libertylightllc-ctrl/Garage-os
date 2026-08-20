import Link from "next/link";
import { floorNow } from "@/lib/work-session";
import { getT } from "@/i18n/server";

/**
 * Tech-tracking slice 1 — the live "Floor right now" board: which tech
 * is on which car, plus who's idle. Server component, refreshes on
 * page load. Rendered on the owner dashboard and, for MASTER, at the
 * top of the Workshop screen.
 *
 * jobHref: owner links into /advisor/jobs (their working surface);
 * the workshop strip links into /technician/jobs.
 *
 * NO per-row duration reading here anymore (AR 2026-08-20 Finding 2
 * follow-up). The previous "⏱ 1788m" chip measured
 * WorkSession.startedAt → now, which diverges from the JobTimings
 * "Diagnosis: 3h 44m so far" caption on the same screen when a
 * session leaks across a release + re-claim. Two clocks on one row
 * showing different numbers for the same job is worse than one. The
 * JobTimings caption under the card is the surviving read — it
 * measures workflow-stage duration from JobCard.claimedAt, and that
 * clock resets on re-claim.
 */
export async function FloorNow({
  garageIds,
  jobHrefBase,
}: {
  garageIds: string[];
  jobHrefBase: "/advisor/jobs" | "/technician/jobs";
}) {
  const t = await getT();
  // Every other query on the owner dashboard degrades gracefully via
  // Promise.allSettled — this one used to throw and kill the whole page
  // when the DB flaked. Wrap the call so a transient failure renders an
  // empty board with a soft caption rather than a full error boundary.
  let working: Awaited<ReturnType<typeof floorNow>>["working"] = [];
  let idle: Awaited<ReturnType<typeof floorNow>>["idle"] = [];
  let failed = false;
  try {
    const res = await floorNow(garageIds);
    working = res.working;
    idle = res.idle;
  } catch (e) {
    console.error("[FloorNow] query failed — degrading to empty board:", e);
    failed = true;
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">🔧 {t("floorNow")}</h2>
      </div>
      {failed ? (
        <p className="mt-3 text-sm text-text-mute">{t("floorNowUnavailable")}</p>
      ) : working.length === 0 ? (
        <p className="mt-3 text-sm text-text-mute">{t("floorNowEmpty")}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {working.map((s) => (
            <li
              key={s.tech.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2/60 px-3 py-2 text-sm"
            >
              <span className="font-medium">{s.tech.name}</span>
              <Link
                href={`${jobHrefBase}/${s.jobCard.id}`}
                className="text-text-mute hover:text-text hover:underline"
              >
                {s.jobCard.vehicle.make} {s.jobCard.vehicle.model} ·{" "}
                {s.jobCard.vehicle.plate}
                {s.jobCard.bay ? ` · ${s.jobCard.bay.name}` : ""}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {idle.length > 0 ? (
        <p className="mt-3 text-xs text-text-mute">
          {t("floorNowIdle")}: {idle.map((u) => u.name).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}
