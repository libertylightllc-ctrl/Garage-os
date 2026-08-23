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
 *
 * Prefer `normalizeCustomerPhoneForWrite` (below) for any code path
 * that persists a customer's phone — it stores in E.164 and reports
 * whether the input resolved. `normalizeUaePhone` remains as the raw
 * canonicalisation primitive (still used by the WhatsApp webhook
 * cross-shape lookup and by legacy tests).
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

// Imported here (not at top) so the module boundary reads left→right
// as "primitives → composites"; the write helper is the only export
// that reaches into wa.ts.
import { normalizeToE164 } from "./wa";

/**
 * The write-time contract for `Customer.phone` (AR 2026-08-23).
 *
 * Every path that persists or updates a customer's phone should route
 * through this helper. Returns the E.164 form when the input resolves,
 * or the raw (trimmed) input plus a needsReview flag when it doesn't.
 *
 * `needsReview = true` gets stored on `Customer.phoneNeedsReview` so
 * the customer detail page can highlight the row for an advisor to
 * fix. The send path (billing/purchasing wa.me actions) already
 * degrades to the contact-picker when phoneE164 is null, which is
 * the right behaviour for an unresolvable but real number — this
 * helper's job is to say WHY, not to refuse the write. See
 * `docs/GarageOS-Technical-Spec.md` for the four write paths that
 * must adopt this.
 *
 *   normalizeCustomerPhoneForWrite("0567424133")   → { phone: "971567424133", needsReview: false }
 *   normalizeCustomerPhoneForWrite("567424133")    → { phone: "971567424133", needsReview: false }
 *   normalizeCustomerPhoneForWrite("+971567424133") → { phone: "971567424133", needsReview: false }
 *   normalizeCustomerPhoneForWrite("call at 5pm")  → { phone: "call at 5pm", needsReview: true }
 *   normalizeCustomerPhoneForWrite("")             → null (caller enforces required-ness)
 */
export function normalizeCustomerPhoneForWrite(
    raw: string,
): { phone: string; needsReview: boolean } | null {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return null;
    const e164 = normalizeToE164(trimmed);
    if (e164) return { phone: e164, needsReview: false };
    return { phone: trimmed, needsReview: true };
}
