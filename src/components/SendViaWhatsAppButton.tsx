import { MessageCircle } from "lucide-react";

/**
 * "Send via WhatsApp" button — a plain anchor to a wa.me URL that
 * opens WhatsApp with a drafted message. Staff taps it, WhatsApp
 * opens, staff hits Send. Message is sent from the staff's personal
 * WhatsApp (not the shop's number — that upgrade is the future Cloud
 * API path, out of this scope).
 *
 * `href` is always a valid wa.me URL now (AR, 2026-08-11). Two shapes
 * upstream in buildWaMeUrl:
 *   - Direct-chat: `wa.me/{phone}?text=…` when the customer's phone
 *     normalizes to E.164 → WhatsApp opens that customer's chat.
 *   - Picker: `wa.me/?text=…` when the phone is missing/malformed →
 *     WhatsApp opens its native contact picker with the message
 *     pre-filled; staff picks who to send to.
 *
 * The button no longer renders as disabled. Before this change, a
 * bad customer phone left the cashier with a dead-end button — the
 * only escape was fixing the customer record, and the customer-edit
 * page has a separate bug that blocks that. Now the send is always
 * possible; data cleanup happens on its own schedule.
 *
 * `disabledReason` is deprecated but kept in the API so callers don't
 * have to change. Ignored at render.
 *
 * Server component — no client state needed. Just an <a href>.
 *
 * For PURCHASE ORDERS (which are audited via PurchaseOrderSend), use
 * SendPoViaWhatsAppButton instead — it POSTs to a server action that
 * logs the HANDED_OFF row before redirecting to wa.me.
 */
export function SendViaWhatsAppButton({
    href,
    label,
    className,
}: {
    /** wa.me URL — always non-null after the 2026-08-11 always-tappable change. */
    href: string;
    /** Localized button label, e.g. "Send via WhatsApp" / "إرسال عبر واتساب". */
    label: string;
    /** @deprecated no longer used — button is always enabled. Accepted for API compat. */
    disabledReason?: string;
    className?: string;
}) {
    const base =
        "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors";

    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={
                (className ?? "") +
                " " +
                base +
                " bg-[#25D366] text-white shadow-sm hover:bg-[#1ebe57] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            }
        >
            <MessageCircle aria-hidden="true" className="h-4 w-4" />
            {label}
        </a>
    );
}
