import { MessageCircle } from "lucide-react";

/**
 * "Send via WhatsApp" — Purchase-Order variant.
 *
 * Different from src/components/SendViaWhatsAppButton (the invoice /
 * customer flow) in ONE way: this posts to a server action that
 * writes an audit row (PurchaseOrderSend, status=HANDED_OFF) BEFORE
 * redirecting to wa.me. The customer-invoice flow doesn't have an
 * audit table, so it stays a plain anchor.
 *
 * The two variants share the same visual — same colour, same icon,
 * same disabled shape — because to the user they're the same button.
 * The audit is a shop-side invariant, not a user-facing one.
 *
 * When `disabled` is true (supplier phone missing or unnormalizable),
 * renders a non-submitting span with a tooltip. Same fail-visible
 * pattern as the invoice variant.
 */
export function SendPoViaWhatsAppButton({
    action,
    poId,
    label,
    disabled,
    disabledReason,
    className,
}: {
    /** Server action that consumes the form. Writes the audit row + redirects. */
    action: (formData: FormData) => void | Promise<void>;
    poId: string;
    /** Localized button label, e.g. "Send via WhatsApp" / "إرسال عبر واتساب". */
    label: string;
    /** True when the button should render disabled (missing / bad phone). */
    disabled?: boolean;
    /** Tooltip text when disabled. */
    disabledReason?: string;
    className?: string;
}) {
    const base =
        "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors";

    if (disabled) {
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
        <form action={action} className="contents">
            <input type="hidden" name="id" value={poId} />
            <button
                type="submit"
                className={
                    (className ?? "") +
                    " " +
                    base +
                    " bg-[#25D366] text-white shadow-sm hover:bg-[#1ebe57] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                }
            >
                <MessageCircle aria-hidden="true" className="h-4 w-4" />
                {label}
            </button>
        </form>
    );
}
