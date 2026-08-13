import type { TimelineEvent } from "@/lib/job-timeline";

/**
 * Vertical, chronological audit list of everything that happened to a
 * job. Pure server component — every row comes pre-built from
 * buildJobTimeline + a labels dictionary the caller assembles from the
 * locale.
 *
 * Mobile layout:
 *   ┌──────────────────────────────────────────┐
 *   │ 09:00   Vehicle checked in               │
 *   │         — Aisha (Advisor)                │
 *   ├──────────────────────────────────────────┤
 *   │ 09:30   Claimed by technician            │
 *   │         — Tariq (Technician)             │
 *   └──────────────────────────────────────────┘
 *
 * Times default to HH:mm; rows that fall on a different calendar day
 * than the previous row get a small "Mon 16 Jun" sub-header so a
 * multi-day job reads naturally without an extra timestamp column.
 *
 * No actor recorded → muted "—" caption (honest, no guessing).
 */

export interface JobTimelineLabels {
    /** Section title — "Job timeline". */
    title: string;
    /** Caption when actor isn't recorded — typically "—". */
    unknownActor: string;
    /** kindKey → translated label. */
    events: Record<string, string>;
    /** Raw role enum → translated role name (e.g. ADVISOR → "Advisor"). */
    role: Record<string, string>;
    /** "Today" prefix for the date sub-header on rows from today. */
    today: string;
}

interface Props {
    events: TimelineEvent[];
    labels: JobTimelineLabels;
    /** Server-rendered "now" used to compare day boundaries. Passed
     *  explicitly so the component is deterministic — same input,
     *  same output — and we don't read system time mid-render. */
    now?: Date;
}

const fmtTime = (d: Date) =>
    d.toISOString().slice(11, 16);

const fmtDate = (d: Date) =>
    d.toISOString().slice(0, 10);

function dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
}

export function JobTimeline({ events, labels, now }: Props) {
    if (events.length === 0) return null;
    const todayKey = (now ?? events[events.length - 1].at).toISOString().slice(0, 10);

    let lastDay = "";
    return (
        // print:hidden — the timeline is an INTERNAL audit view (who
        // did what when). Every doc surface that embeds it (invoice
        // edit, estimate edit, tech job page, advisor job print) does
        // NOT want it on paper — customers don't need it, and it
        // pushes A4 documents onto a second page. Applying it at the
        // component root so all call sites inherit; per-page overrides
        // can wrap in a container that undoes it if ever needed.
        // (AR 2026-08-14 — invoice print running to two pages.)
        <section className="flex flex-col gap-2 print:hidden">
            <h2 className="text-sm font-semibold">{labels.title}</h2>
            <ol className="flex flex-col gap-0 rounded-xl border border-border">
                {events.map((e, idx) => {
                    const dKey = dayKey(e.at);
                    const showDay = dKey !== lastDay;
                    lastDay = dKey;
                    const evLabel = labels.events[e.kindKey] ?? e.kindKey;
                    const roleLabel = e.actor
                        ? labels.role[e.actor.role] ?? e.actor.role
                        : null;
                    return (
                        <li
                            key={idx}
                            className={`flex flex-col gap-0.5 px-3 py-2 text-sm ${idx > 0 ? "border-t border-border" : ""}`}
                        >
                            {showDay ? (
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-mute">
                                    {dKey === todayKey ? labels.today : fmtDate(e.at)}
                                </p>
                            ) : null}
                            <div className="flex items-baseline gap-3">
                                <span className="w-12 shrink-0 tabular-nums text-xs text-text-mute">
                                    {fmtTime(e.at)}
                                </span>
                                <span className="flex-1 break-words">
                                    {evLabel}
                                    {e.detail ? (
                                        <span className="ms-1 text-text-mute">— {e.detail}</span>
                                    ) : null}
                                </span>
                            </div>
                            <p className="ps-[3.75rem] text-xs text-text-mute">
                                — {e.actor && roleLabel
                                    ? `${e.actor.name} (${roleLabel})`
                                    : labels.unknownActor}
                            </p>
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}
