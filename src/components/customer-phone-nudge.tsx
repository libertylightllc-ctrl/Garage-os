/**
 * Soft-nudge banner shown above the Send button on estimate /
 * invoice preview pages when the customer's phone can't be
 * normalised to a wa.me-compatible number (AR 2026-08-23).
 *
 * The customer-side WhatsApp send action is deliberately forgiving:
 * on a bad/missing phone, it falls through to WhatsApp's contact
 * picker so the cashier can still get the doc out (see the
 * DELIBERATE DIVERGENCE comment on sendEstimateToCustomerAction /
 * sendInvoiceToCustomerAction). That behaviour is right — a
 * customer needs their invoice; blocking on data-cleanup is worse
 * than a picker. But silent degradation means nobody ever fixes the
 * underlying record. This banner surfaces the reason so the next
 * send is one-tap.
 *
 * Pure server component — no interactivity, no runtime cost when
 * the phone normalises fine (returns null via the caller's guard).
 * The caller renders it inside the "Send to customer" action bar.
 */

interface Props {
    rawPhone: string | null;
    labels: {
        heading: string;
        rawLabel: string;
        /** e.g. "(none captured)" for empty phone. */
        rawNone: string;
    };
}

export function CustomerPhoneNudge({ rawPhone, labels }: Props) {
    return (
        <div
            role="status"
            className="print:hidden mb-2 rounded-lg border border-warning-500/40 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500"
        >
            <div className="font-medium">⚠️ {labels.heading}</div>
            <div className="mt-0.5">
                {labels.rawLabel}{" "}
                <span className="font-mono">
                    {rawPhone && rawPhone.trim() !== ""
                        ? rawPhone
                        : labels.rawNone}
                </span>
            </div>
        </div>
    );
}
