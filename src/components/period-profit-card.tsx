// Per-period profit widget (AR 2026-08-22, profit reporting Step 6).
//
// Three stats rendered at the SAME visual weight per spec: Revenue,
// Profit, Coverage. Coverage is NOT small print — it's the third
// column, same size + font as the money numbers, because a 45%-
// coverage profit reading is a very different signal from a 100%-
// coverage one and the owner needs to see that at the same glance.
//
// If profit is null (every invoice in the range had at least one
// Unknown side), the profit column shows "—" not "AED 0.00" — the
// spec's "unknown, not a computed number" discipline.
//
// Pure server component — no client interactivity. Number formatting
// happens here; the caller passes PeriodProfit as-is.

import type { PeriodProfit } from "@/lib/period-profit";

interface Props {
    title: string;
    profit: PeriodProfit;
    /** e.g. "Margins use weighted-average part cost, not per-unit cost." */
    footnote: string;
    /**
     * Labels — passed in for i18n. Widget stays text-agnostic so the
     * caller controls the language + RTL layout.
     */
    labels: {
        revenue: string;
        profit: string;
        coverage: string;
        /** e.g. "{covered} of {total} jobs" */
        coverageOf: string;
    };
}

const money = (n: number | null): string =>
    n === null ? "—" : `AED ${n.toFixed(2)}`;

export function PeriodProfitCard({ title, profit, footnote, labels }: Props) {
    const profitNum = profit.profit === null ? null : Number(profit.profit);
    const revenueNum = Number(profit.revenue);
    const coverageText =
        profit.coverage.pct === null
            ? "—"
            : `${profit.coverage.pct}%`;
    const coverageDetail = labels.coverageOf
        .replace("{covered}", String(profit.coverage.covered))
        .replace("{total}", String(profit.coverage.total));

    return (
        <section
            aria-label={title}
            className="rounded-2xl border border-border bg-surface-2 p-6"
        >
            <h2 className="mb-4 text-sm font-medium text-text-mute">{title}</h2>
            <div className="grid gap-6 sm:grid-cols-3">
                {/* Revenue — always known. */}
                <div>
                    <div className="text-xs uppercase tracking-wide text-text-mute">
                        {labels.revenue}
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">
                        {money(revenueNum)}
                    </div>
                </div>
                {/* Profit — "—" when zero invoices are fully covered. */}
                <div>
                    <div className="text-xs uppercase tracking-wide text-text-mute">
                        {labels.profit}
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">
                        {money(profitNum)}
                    </div>
                </div>
                {/* Coverage — SAME visual weight as revenue + profit. Not
                    small-print. The spec is explicit: a partial-coverage
                    profit reading looks the same as a full-coverage one
                    unless coverage sits beside them at the same size. */}
                <div>
                    <div className="text-xs uppercase tracking-wide text-text-mute">
                        {labels.coverage}
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">
                        {coverageText}
                    </div>
                    <div className="mt-1 text-xs text-text-mute">
                        {coverageDetail}
                    </div>
                </div>
            </div>
            <p className="mt-4 text-xs text-text-mute">{footnote}</p>
        </section>
    );
}
