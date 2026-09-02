import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { PrintButton } from "@/components/print-button";
import { computePnl } from "@/lib/pnl";

/** AR: negative deltas render as "−AED 1500.00", never "AED -1500.00". */
function money(n: number): string {
    if (n < 0) return `−AED ${Math.abs(n).toFixed(2)}`;
    return `AED ${n.toFixed(2)}`;
}

export const dynamic = "force-dynamic";

/**
 * P&L — E3b (AR 2026-09-02).
 *
 * Reads LedgerEntry via computePnl(). Owner-only per financial-reporting
 * rule. Date range from URL (?from=YYYY-MM-DD&to=YYYY-MM-DD), defaulting
 * to month-to-date. Presets link to fresh URLs — no client-side state.
 *
 * Coverage banner (customer-facing text — no internal rule numbers,
 * see rule 13 "stay prominent" note):
 *   • cogsEnabled=false → "Cost tracking is off for this garage.
 *     Revenue is real. COGS shows AED 0 because parts-cost tracking
 *     hasn't been switched on yet."
 *   • cogsEnabled=true + partial coverage → "N of M invoices costed
 *     (X%)" in text-base/semibold so the percentage stays prominent
 *     even at 70%+ coverage when the raw ratio stops being alarming;
 *     body explains "invoices raised before cost tracking was
 *     switched on stay uncosted."
 *   • Full coverage → no banner.
 *
 * Banner is inside data-print-document="pnl" (no print:hidden) —
 * prints alongside the P&L body. A P&L that leaves the building
 * without the coverage line beside it is the document that gets
 * believed.
 */
export default async function PnlPage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string; to?: string }>;
}) {
    const session = await requireRole("OWNER");
    const params = await searchParams;

    // Default range: month-to-date in the operator's local calendar.
    // We build Dates in UTC — the ledger stores UTC and the shop's
    // month boundary is close enough (UAE = UTC+4; a receipt logged
    // at 23:30 local Sept 30 lands at 19:30 UTC same day). For the
    // MVP this is close enough; a per-garage timezone flip is a
    // future enhancement, not blocking rule-10 rollout.
    const now = new Date();
    const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const fromDate = params.from ? new Date(params.from + "T00:00:00Z") : defaultFrom;
    const toDate = params.to ? new Date(params.to + "T00:00:00Z") : defaultTo;
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        throw new Error("Invalid date range");
    }

    const pnl = await computePnl(session.user.garageId, fromDate, toDate);

    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
    const rangeLabel = `${fmtDate(fromDate)} → ${fmtDate(new Date(toDate.getTime() - 1))}`;

    // Presets — links to the same page with different query string.
    const monthStart = (offset: number) => {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
        return fmtDate(d);
    };
    const yearStart = fmtDate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
    const today = fmtDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));

    const presets = [
        { label: "Month to date", from: monthStart(0), to: today },
        { label: "Last month", from: monthStart(-1), to: monthStart(0) },
        { label: "Year to date", from: yearStart, to: today },
    ];

    const coveragePct =
        pnl.coverage.invoicesTotal > 0
            ? Math.round((pnl.coverage.invoicesCosted / pnl.coverage.invoicesTotal) * 100)
            : null;

    return (
        <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
            <div className="print:hidden">
                <AppNav role="OWNER" active="accounting" />
            </div>

            <div className="flex items-baseline justify-between gap-4 print:hidden">
                <div>
                    <div className="text-xs text-text-mute">
                        <Link href="/owner/accounting" className="hover:underline">
                            Accounting
                        </Link>{" "}
                        · P&amp;L
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight">Profit &amp; Loss</h1>
                </div>
                <PrintButton className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-sm font-medium hover:bg-surface-2 print:hidden">
                    Print
                </PrintButton>
            </div>

            <div
                className="flex flex-col gap-6 rounded-xl border border-border bg-surface p-6 print:border-none print:bg-transparent print:p-0"
                data-print-document="pnl"
            >
                <div className="hidden print:block">
                    <h2 className="text-lg font-semibold">Profit &amp; Loss</h2>
                    <p className="text-xs text-text-mute">{rangeLabel}</p>
                </div>

                {/* Date range form + presets */}
                <form
                    method="get"
                    className="flex flex-wrap items-end gap-3 border-b border-border pb-4 print:hidden"
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="text-text-mute">From</span>
                        <input
                            type="date"
                            name="from"
                            defaultValue={fmtDate(fromDate)}
                            className="h-9 rounded-lg border border-border bg-surface px-2 text-sm"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="text-text-mute">To (exclusive)</span>
                        <input
                            type="date"
                            name="to"
                            defaultValue={fmtDate(toDate)}
                            className="h-9 rounded-lg border border-border bg-surface px-2 text-sm"
                        />
                    </label>
                    <button className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-sm font-medium hover:bg-surface-2">
                        Apply
                    </button>
                    <div className="ml-auto flex flex-wrap gap-1 text-xs">
                        {presets.map((p) => (
                            <Link
                                key={p.label}
                                href={`/owner/accounting/pnl?from=${p.from}&to=${p.to}`}
                                className="rounded-lg border border-border px-2 py-1 hover:bg-surface-2"
                            >
                                {p.label}
                            </Link>
                        ))}
                    </div>
                </form>

                {/* Coverage banner — only when there's something to explain */}
                {pnl.coverage.cogsFlagOff && pnl.revenueTotal > 0 ? (
                    <div className="rounded-lg border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        <div className="font-medium">Cost tracking is off for this garage.</div>
                        <div className="mt-1 text-xs">
                            Revenue is real. Cost of Goods Sold shows AED 0 because parts-cost
                            tracking hasn't been switched on yet. Until it is, Gross Profit
                            here overstates by the parts-cost of every invoice raised this period.
                        </div>
                    </div>
                ) : null}
                {!pnl.coverage.cogsFlagOff &&
                pnl.coverage.invoicesTotal > 0 &&
                pnl.coverage.invoicesCosted < pnl.coverage.invoicesTotal ? (
                    <div className="rounded-lg border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        <div className="text-base font-semibold">
                            {pnl.coverage.invoicesCosted} of {pnl.coverage.invoicesTotal} invoices costed
                            ({coveragePct}%)
                        </div>
                        <div className="mt-1 text-xs">
                            Invoices raised before cost tracking was switched on stay uncosted.
                            Invoices whose PART lines had no supplier cost recorded also skipped
                            their cost-of-sales entry. Gross Profit here overstates by the
                            parts-cost of the{" "}
                            {pnl.coverage.invoicesTotal - pnl.coverage.invoicesCosted} uncosted
                            invoice(s) in this period.
                        </div>
                    </div>
                ) : null}

                {/* Revenue */}
                <section className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-text-mute">
                        Revenue
                    </h3>
                    {pnl.revenue.length === 0 ? (
                        <p className="text-sm text-text-mute">No revenue in this period.</p>
                    ) : (
                        pnl.revenue.map((line) => (
                            <div
                                key={line.account}
                                className="flex items-baseline justify-between border-b border-border/60 pb-1 text-sm"
                            >
                                <span>{line.account}</span>
                                <span className="tabular-nums">{money(line.amount)}</span>
                            </div>
                        ))
                    )}
                    <div className="mt-1 flex items-baseline justify-between text-sm font-semibold">
                        <span>Total Revenue</span>
                        <span className="tabular-nums">{money(pnl.revenueTotal)}</span>
                    </div>
                </section>

                {/* COGS + Gross */}
                <section className="flex flex-col gap-2 border-t border-border pt-4">
                    <div className="flex items-baseline justify-between text-sm">
                        <span>Cost of Goods Sold</span>
                        <span className="tabular-nums">{money(pnl.cogs)}</span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between text-sm font-semibold">
                        <span>Gross Profit</span>
                        <span className="tabular-nums">
                            {money(pnl.grossProfit)}
                            {pnl.grossMarginPct !== null ? (
                                <span className="ml-2 text-xs font-normal text-text-mute">
                                    ({pnl.grossMarginPct.toFixed(1)}%)
                                </span>
                            ) : null}
                        </span>
                    </div>
                </section>

                {/* Operating expenses */}
                <section className="flex flex-col gap-2 border-t border-border pt-4">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-text-mute">
                        Operating Expenses
                    </h3>
                    {pnl.expenses.length === 0 ? (
                        <p className="text-sm text-text-mute">No expenses recorded in this period.</p>
                    ) : (
                        pnl.expenses.map((line) => (
                            <div
                                key={line.account}
                                className="flex items-baseline justify-between border-b border-border/60 pb-1 text-sm"
                            >
                                <span>{line.account}</span>
                                <span className="tabular-nums">{money(line.amount)}</span>
                            </div>
                        ))
                    )}
                    <div className="mt-1 flex items-baseline justify-between text-sm font-semibold">
                        <span>Total Operating Expenses</span>
                        <span className="tabular-nums">{money(pnl.expensesTotal)}</span>
                    </div>
                </section>

                {/* Net */}
                <section className="border-t-2 border-border pt-4">
                    <div className="flex items-baseline justify-between text-base font-semibold">
                        <span>Net Profit</span>
                        <span className="tabular-nums">
                            {money(pnl.netProfit)}
                            {pnl.netMarginPct !== null ? (
                                <span className="ml-2 text-xs font-normal text-text-mute">
                                    ({pnl.netMarginPct.toFixed(1)}%)
                                </span>
                            ) : null}
                        </span>
                    </div>
                </section>
            </div>
        </main>
    );
}
