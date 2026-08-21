import type { MessageKey } from "./config";

/**
 * Count-aware string resolver for i18n keys.
 *
 * AR 2026-08-21 (Batch 3): the codebase's plural convention had been
 * `t("key").replace("{n}", String(count))` — one string for every
 * count. English tolerates that with "(s)" workarounds; Arabic has
 * six inflection categories (zero, one, two, few, many, other) and
 * "{n} جلسة" reads as singular for every count. The audit flagged
 * that plurals were wrong for 3+ in Arabic across the app.
 *
 * How to use:
 *
 *   pluralize(t, 3, "wrenchStaleCount", locale)
 *     → English: "3 long sessions" (via wrenchStaleCount_other)
 *     → Arabic:  "3 جلسات طويلة"    (via wrenchStaleCount_few)
 *
 * Dictionary shape:
 *   keyBase              — base key; used as last-resort fallback
 *   keyBase_one          — 1
 *   keyBase_two          — 2 (Arabic dual)
 *   keyBase_few          — 3-10 (Arabic plural)
 *   keyBase_many         — 11-99 (Arabic paucal)
 *   keyBase_other        — everything else
 *   keyBase_zero         — 0 (optional; en/ar both fall through
 *                          to _other when absent, matching what
 *                          the operator would expect)
 *
 * A caller who only provides `keyBase_one` and `keyBase_other`
 * gets English 2-form behaviour and every AR category falls
 * through to `keyBase_other` — deliberately conservative so a
 * partial translation doesn't render a raw i18n key.
 *
 * The helper takes `t` as a value rather than importing it so
 * callers can pass the same `t` they already got from `getT()`
 * (server) or `useT()` (client). No client-only APIs used;
 * `Intl.PluralRules` is on both.
 */
export function pluralize(
    t: (k: MessageKey) => string,
    count: number,
    keyBase: string,
    locale: string,
): string {
    const category = selectCategory(count, locale);
    // Try _category, then _other, then bare — each lookup is one
    // hasOwn on the loaded dictionary; the fallback tree is cheap.
    // Cast to MessageKey is deliberate: keyBase is caller-supplied
    // and can't be typed narrower without the caller writing the
    // union manually every time.
    const tryKey = (k: string): string | null => {
        const s = t(k as MessageKey);
        // If the dictionary doesn't have the key, `t` typically
        // returns the key itself. Treat that as "not translated"
        // and fall through.
        return s === k ? null : s;
    };
    const raw =
        tryKey(`${keyBase}_${category}`) ??
        tryKey(`${keyBase}_other`) ??
        tryKey(keyBase) ??
        keyBase;
    return raw.replace("{n}", String(count));
}

function selectCategory(count: number, locale: string): string {
    try {
        return new Intl.PluralRules(locale).select(count);
    } catch {
        // A bad locale tag should never blank a page. Fall back to
        // English 2-form.
        return count === 1 ? "one" : "other";
    }
}
