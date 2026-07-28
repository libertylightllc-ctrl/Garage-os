/**
 * Locale-aware relative-time formatter — "2 minutes ago", "قبل ٥ أيام".
 *
 * Used next to the absolute timestamp in the send-history table so a
 * parts office can tell "five sends in a minute" (noise) from "five
 * sends over three days" (a supplier who isn't responding) at a
 * glance. The full timestamp is still shown; this is a hint alongside.
 *
 * Uses Intl.RelativeTimeFormat, which is built into modern Node and
 * every target browser. No allocations per call worth caching (Intl
 * internally caches); if that changes we memoize by locale.
 */

const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
    { unit: "year", seconds: 60 * 60 * 24 * 365 },
    { unit: "month", seconds: 60 * 60 * 24 * 30 },
    { unit: "week", seconds: 60 * 60 * 24 * 7 },
    { unit: "day", seconds: 60 * 60 * 24 },
    { unit: "hour", seconds: 60 * 60 },
    { unit: "minute", seconds: 60 },
    { unit: "second", seconds: 1 },
];

export function relativeTime(from: Date | string | number, locale: string, now: Date = new Date()): string {
    const fromDate = from instanceof Date ? from : new Date(from);
    const diffSec = Math.round((fromDate.getTime() - now.getTime()) / 1000);
    const absSec = Math.abs(diffSec);
    // "just now" — under 5s reads as jittery, past 5s reads as stale.
    if (absSec < 5) {
        // Falls through to `seconds`; Intl handles 0 correctly.
        return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
    }
    for (const { unit, seconds } of UNITS) {
        if (absSec >= seconds) {
            const value = Math.round(diffSec / seconds);
            return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
        }
    }
    // Unreachable (seconds row is 1), but the type checker doesn't know.
    return "";
}
