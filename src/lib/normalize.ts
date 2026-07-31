/**
 * Normalisation helpers for identifier fields that are entered by humans
 * (or OCR) and appear in many formats for the same underlying value.
 *
 * Applied on WRITE (before persistence) and on READ (before comparing
 * two values). New rows are stored normalised; legacy rows in prod may
 * not be, which is why lookups that need to bridge the gap must
 * normalise BOTH the query value AND the stored value at compare time.
 *
 * Slice 1a will catalogue how many legacy rows need backfill; slice 1
 * will add the `normalized*` columns + indexes when the data is clean.
 */

/**
 * VIN / chassis normalisation. VINs are alphanumeric ASCII; nothing
 * else is meaningful. Strip anything that isn't [A-Z0-9] and uppercase
 * the rest so "5N1AR2MM7DC605739", "5n1ar2 mm7dc-605739" and
 * "5N1AR2MM7DC605739 " all reduce to the same string.
 *
 *   normalizeVin("5n1ar2 mm7dc-605739") === "5N1AR2MM7DC605739"
 */
export function normalizeVin(raw: string): string {
    return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Plate normalisation for storage AND comparison. Same rule as VIN:
 * strip spaces / dashes, uppercase. This is the value that goes into
 * `Vehicle.plate` on write and the value used on the read side of the
 * collision check, so a "A 12345" write and an "A-12345" lookup match.
 *
 *   normalizePlate("A 12345") === "A12345"
 *   normalizePlate("a-12345") === "A12345"
 *
 * Slice 1 replaces this with a separate `Vehicle.normalizedPlate`
 * column so display can keep the human formatting the advisor typed
 * while comparison stays canonical. Slice 5 stores only the normalised
 * form; the display cost is small (single-token plates lose spacing)
 * and correctness trumps aesthetics until slice 1 lands.
 */
export function normalizePlate(raw: string): string {
    return raw.replace(/[\s\-]/g, "").toUpperCase();
}

/**
 * UAE phone normalisation. Every UAE mobile is a 9-digit local number
 * after the leading zero / country code is stripped. Reduce all of
 * these to the same value:
 *
 *   "+971 50 123 4567"     → "501234567"
 *   "00971-50-123-4567"    → "501234567"
 *   "971 (50) 1234567"     → "501234567"
 *   "0501234567"           → "501234567"
 *   "501234567"            → "501234567"
 *
 * Not called `normalizePhone` because it deliberately assumes UAE
 * dialling; a future GCC-wide flavour would need per-country handling
 * and shouldn't quietly share this name.
 */
export function normalizeUaePhone(raw: string): string {
    const digitsOnly = raw.replace(/[\s()\-+]/g, "");
    // Order matters: strip 00971 first (would otherwise leave "971..."
    // after the "+"-strip step), then bare 971, then a leading 0.
    return digitsOnly
        .replace(/^00971/, "")
        .replace(/^971/, "")
        .replace(/^0+/, "");
}
