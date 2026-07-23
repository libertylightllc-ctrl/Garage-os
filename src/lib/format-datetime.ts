// Locale + timezone-aware date/time rendering. The whole app renders
// on server components (Vercel Node = UTC), so date strings without an
// explicit timezone silently render 4h behind Dubai wall clock. Every
// human-facing render must pass the correct timezone through — usually
// derived from `garage.country` via `countryToTimeZone()` below.
//
// The helper takes an EXPLICIT `timeZone` argument with no default.
// A forgotten argument is a TypeScript error, not a silent UTC render.
// That is the point of extracting this module.
//
// URL query strings, HTML `<input type="date">` default values,
// grouping keys, and `data-*` HTML attributes must stay on raw
// ISO slices (`d.toISOString().slice(0, 10)`) — those are machine-
// facing, not user-facing, and locale-formatting them would break
// URL round-tripping and sortable grouping. See the migration doc
// (Commit 3) for the leave-raw list.
//
// FOLLOW-UP (not this module): src/app/advisor/reminders/page.tsx
// uses `Date.UTC(...)` + `getUTCMonth()` for month-boundary bucketing.
// A reminder due 2026-08-01 02:00 Asia/Dubai (= 2026-07-31 22:00 UTC)
// gets bucketed into July. Reminder month-math needs its own helper
// module (month-boundary.ts) that takes an explicit `timeZone` too.
// Logged so the bug isn't forgotten — see report from 2026-07-23.

/**
 * Map a Garage's `country` value to its canonical IANA timezone. The
 * app is UAE-only in phase 1 (per AGENTS.md KEY DECISION #1) but the
 * GCC-6 map is populated now so onboarding a KSA / Kuwait / etc.
 * garage doesn't need a code change — only a Garage row insert.
 *
 * Fallback: unrecognised country → Asia/Dubai. Safe for the phase-1
 * default and matches the schema default at Garage.country ("UAE").
 * A silent fallback here is chosen over a throw so a mistyped country
 * on a legacy row doesn't 500 a customer-facing invoice page.
 */
export function countryToTimeZone(country: string): string {
    switch (country) {
        case "UAE":
            return "Asia/Dubai";
        case "KSA":
            return "Asia/Riyadh";
        case "Kuwait":
            return "Asia/Kuwait";
        case "Bahrain":
            return "Asia/Bahrain";
        case "Qatar":
            return "Asia/Qatar";
        case "Oman":
            return "Asia/Muscat";
        default:
            return "Asia/Dubai";
    }
}

/**
 * Full date + time — e.g. "Jul 23, 2026, 7:29 AM" (en) or
 * "23‏/07‏/2026، 7:29 ص" (ar). Wraps `toLocaleString(locale,
 * { dateStyle: 'medium', timeStyle: 'short', timeZone })`.
 *
 * Use for: check-in stamps, delivery timestamps, "sent at", audit
 * event lines, any surface where the hour matters to the reader.
 */
export function fmtDateTime(d: Date, locale: string, timeZone: string): string {
    return d.toLocaleString(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
    });
}

/**
 * Date only — e.g. "Jul 23, 2026" (en) or "23 يوليو 2026" (ar).
 * Wraps `toLocaleDateString(locale, { dateStyle: 'medium', timeZone })`.
 *
 * Use for: invoice "issued" date, estimate "issued" date, due dates,
 * ledger row dates, admin garage list "created" column.
 */
export function fmtDate(d: Date, locale: string, timeZone: string): string {
    return d.toLocaleDateString(locale, {
        dateStyle: "medium",
        timeZone,
    });
}

/**
 * Time only — e.g. "7:29 AM" (en) or "7:29 ص" (ar). Wraps
 * `toLocaleTimeString(locale, { timeStyle: 'short', timeZone })`.
 *
 * Use for: any rare surface where the date is already established
 * from context and only the time needs to render.
 */
export function fmtTime(d: Date, locale: string, timeZone: string): string {
    return d.toLocaleTimeString(locale, {
        timeStyle: "short",
        timeZone,
    });
}

/**
 * Month + year — e.g. "July 2026" (en) or "يوليو 2026" (ar). Wraps
 * `toLocaleDateString(locale, { month: 'long', year: 'numeric',
 * timeZone })`.
 *
 * Use for: monthly report headers, month-picker labels. Not for
 * bucketing math — that's the follow-up month-boundary helper.
 */
export function fmtMonthYear(d: Date, locale: string, timeZone: string): string {
    return d.toLocaleDateString(locale, {
        month: "long",
        year: "numeric",
        timeZone,
    });
}
