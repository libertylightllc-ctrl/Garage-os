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
 */
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

    return digits;
}

/**
 * Build the wa.me URL for a given normalized phone + message. Callers
 * should pass the OUTPUT of normalizeToE164 for `phoneE164`. The text
 * is URL-encoded here so callers can pass the raw template output.
 */
export function buildWaMeUrl(phoneE164: string, text: string): string {
    return `https://wa.me/${phoneE164}?text=${encodeURIComponent(text)}`;
}
