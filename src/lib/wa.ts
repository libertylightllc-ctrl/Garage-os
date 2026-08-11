/**
 * Client-side "Send via WhatsApp" helpers.
 *
 * We use the wa.me URL scheme (https://faq.whatsapp.com/5913398998672934)
 * — Meta's official + explicitly-supported way to open a chat with a
 * given number and a pre-filled message. Zero API surface, zero
 * automation, zero ban risk. The staff member taps the button, their
 * WhatsApp opens with the customer's number + the drafted text, they
 * tap Send. The message goes from the STAFF's personal WhatsApp, not
 * the shop's number — that upgrade requires the Cloud API path
 * (sendWhatsApp() in whatsapp.ts) which is scoped separately.
 */

/**
 * Normalize a phone string into an E.164-shaped digit-only string
 * suitable for wa.me. Returns null if the input can't plausibly be
 * turned into an international number — the button that consumes this
 * should render disabled in that case rather than open a broken chat.
 *
 * Rules:
 *   - Strip everything except digits, "+", and leading "0"s.
 *   - Leading "+" → drop the "+".
 *   - Leading "00" → drop the "00" (international dial prefix).
 *   - Leading "0" + 9 more digits (local UAE like 0501234567) →
 *     replace the "0" with the default country code (971 for UAE).
 *   - Otherwise: accept if what remains is 8-15 digits.
 *
 * Additional GCC gate (2026-08-10, INV-2026-0039 diagnosis): after the
 * normalization above, the resulting digit string MUST start with a
 * recognised GCC country code. `509633280` (9 digits, no leading 0,
 * no country prefix) previously slipped through as valid — wa.me then
 * opened a chat with a number that doesn't exist, and the send
 * silently reached nobody. Rejecting up front stops the same bug
 * class. GarageOS is UAE-only at launch (see AGENTS.md), but the
 * broader GCC set is accepted because expat customers commonly use
 * numbers from KSA/Oman/Qatar/Bahrain/Kuwait roaming into the UAE.
 */
export const GCC_COUNTRY_CODES = [
    "971", // United Arab Emirates
    "966", // Saudi Arabia
    "968", // Oman
    "974", // Qatar
    "973", // Bahrain
    "965", // Kuwait
] as const;

function startsWithGccCode(digits: string): boolean {
    return GCC_COUNTRY_CODES.some((c) => digits.startsWith(c));
}

export function normalizeToE164(
    raw: string | null | undefined,
    defaultCountry = "971",
): string | null {
    if (raw == null) return null;
    // Keep only digits and the plus sign; drop spaces, dashes,
    // parens, dots, letters, everything else.
    const cleaned = String(raw).replace(/[^\d+]/g, "");
    if (!cleaned) return null;

    let digits: string;
    if (cleaned.startsWith("+")) {
        digits = cleaned.slice(1);
    } else if (cleaned.startsWith("00")) {
        digits = cleaned.slice(2);
    } else if (cleaned.startsWith("0") && cleaned.length === 10) {
        // Local-format UAE mobile: 0501234567 → 971501234567
        digits = defaultCountry + cleaned.slice(1);
    } else {
        digits = cleaned;
    }

    // A "+" that got dropped may have left leading zeros to strip too.
    while (digits.startsWith("0")) digits = digits.slice(1);

    // Any non-digit slipped through (e.g. a stray "+") → reject.
    if (!/^\d+$/.test(digits)) return null;
    // E.164 allows 8-15 digits including country code; be permissive
    // enough for real GCC numbers (~11-12 digits) and reject obvious
    // junk like a 3-digit typo.
    if (digits.length < 8 || digits.length > 15) return null;
    // Country-code gate — the fix for the AHMED case. A number that
    // survived every earlier rule but doesn't start with a code we
    // recognise is almost always a UAE mobile that lost its leading
    // 0 during copy-paste, or an accidentally-truncated foreign
    // number. Rather than opening a wa.me chat that goes nowhere,
    // return null so the caller renders a disabled button.
    if (!startsWithGccCode(digits)) return null;

    return digits;
}

/**
 * Build the wa.me URL for a message + optional phone.
 *
 * Two shapes, both official WhatsApp:
 *   - With phone: `https://wa.me/{E164}?text={message}` — WhatsApp
 *     opens the chat with that number directly, message pre-filled.
 *   - Without phone (null): `https://wa.me/?text={message}` — WhatsApp
 *     opens its native CONTACT PICKER with the message pre-filled;
 *     the sender chooses who to send to before tapping Send.
 *
 * The picker shape was added 2026-08-11 after AR flagged that a bad
 * customer phone left the cashier with a dead-end button (see the
 * SendViaWhatsAppButton doc). Rather than block the send, we hand the
 * cashier a picker: they can pick the customer via a different
 * number, forward to a colleague, or send to their own phone as a
 * copy. The customer-data cleanup that used to be forced by the
 * disabled state now happens as a separate concern.
 *
 * Callers should pass the OUTPUT of normalizeToE164 for `phoneE164`.
 * The text is URL-encoded here so callers can pass the raw template
 * output verbatim.
 */
export function buildWaMeUrl(phoneE164: string | null, text: string): string {
    const encoded = encodeURIComponent(text);
    if (phoneE164) return `https://wa.me/${phoneE164}?text=${encoded}`;
    // Contact-picker variant — no number segment before `?`.
    return `https://wa.me/?text=${encoded}`;
}
