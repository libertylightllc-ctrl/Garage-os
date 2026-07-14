import { MessageCircle } from "lucide-react";

/**
 * "Send via WhatsApp" button — a plain anchor to a wa.me URL that
 * opens WhatsApp with the customer's number + a drafted message.
 * Staff taps it, WhatsApp opens, staff hits Send. Message is sent
 * from the staff's personal WhatsApp (not the shop's number — that
 * upgrade is the future Cloud API path, out of this scope).
 *
 * When `href` is null (customer phone was missing / unnormalizable),
 * renders a disabled non-link with a tooltip explaining why. This
 * matches how phones are validated across the intake surfaces —
 * fail-visible not fail-silent.
 *
 * Server component — no client state needed. Just an <a href>.
 */
export function SendViaWhatsAppButton({
    href,
    label,
    disabledReason,
    className,
}: {
    /** wa.me URL, or null to render disabled. */
    href: string | null;
    /** Localized button label, e.g. "Send via WhatsApp" / "إرسال عبر واتساب". */
    label: string;
    /** Tooltip when disabled, e.g. "Customer phone number is missing". */
    disabledReason?: string;
    className?: string;
}) {
    const base =
        "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors";

    if (!href) {
        return (
            <span
                title={disabledReason}
                aria-disabled="true"
                className={
                    (className ?? "") +
                    " " +
                    base +
                    " cursor-not-allowed bg-surface-2 text-text-mute"
                }
            >
                <MessageCircle aria-hidden="true" className="h-4 w-4 opacity-70" />
                {label}
            </span>
        );
    }

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
