import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { PrintButton } from "@/components/print-button";
import { computeStatements } from "@/lib/statements";

/** AR: negative deltas render as "−AED 1500.00", never "AED -1500.00". */
function money(n: number): string {
    if (n < 0) return `−AED ${Math.abs(n).toFixed(2)}`;
    return `AED ${n.toFixed(2)}`;
}

export const dynamic = "force-dynamic";

/**
 * Trial balance + balance sheet — E5 (AR 2026-09-03).
 *
 * Reads LedgerEntry as of a date (default: end of yesterday, so
 * "today" shows a completed picture). Owner-only, financial
 * reporting bucket.
 *
 * Equity is DERIVED (Revenue − COGS − Expenses, all time) —
 * no closing entries posted. Coverage banner inherits the P&L's
 * cogsFlagOff / uncosted-invoice caveats. If Assets ≠ Liabilities
 * + Equity, the delta shows explicitly rather than being hidden
 * by a plug. See rule 16.
 */
export default async function StatementsPage({
    searchParams,
}: {
    searchParams: Promise<{ asOf?: string }>;
}) {
    const session = await requireRole("OWNER");
    const params = await searchParams;

    const now = new Date();
    const defaultAsOf = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    const asOf = params.asOf ? new Date(params.asOf + "T00:00:00Z") : defaultAsOf;
    if (isNaN(asOf.getTime())) {
        throw new Error("Invalid date");
    }

    const s = await computeStatements(session.user.garageId, asOf);

    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
    const asOfLabel = fmtDate(new Date(asOf.getTime() - 1)); // last day INCLUDED
    const totalEquity = s.openingBalanceEquity + s.accumulatedProfit;
    const totalLiabilitiesAndEquity = s.liabilities + totalEquity;

    const coveragePct =
        s.coverage.invoicesTotal > 0
            ? Math.round((s.coverage.invoicesCosted / s.coverage.invoicesTotal) * 100)
            : null;

    const rowsBy = (type: string) => s.rows.filter((r) => r.type === type);
    const assetRows = rowsBy("ASSET");
    const liabilityRows = rowsBy("LIABILITY");
    const revenueRows = rowsBy("REVENUE");
    const expenseRows = rowsBy("EXPENSE");

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
                        · Trial balance &amp; balance sheet
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight">
                        Trial balance &amp; balance sheet
                    </h1>
                    <p className="mt-1 max-w-2xl text-sm text-text-mute">
                        Point-in-time view of every account and the balance-sheet equation. Both
                        computed from the ledger; no closing entries posted (see the equity note
                        below).
                    </p>
                </div>
                <PrintButton className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-sm font-medium hover:bg-surface-2 print:hidden">
                    Print
                </PrintButton>
            </div>

            <div
                className="flex flex-col gap-6 rounded-xl border border-border bg-surface p-6 print:border-none print:bg-transparent print:p-0"
                data-print-document="statements"
            >
                <div className="hidden print:block">
                    <h2 className="text-lg font-semibold">Trial balance &amp; balance sheet</h2>
                    <p className="text-xs text-text-mute">As of {asOfLabel}</p>
                </div>

                {/* Date form */}
                <form
                    method="get"
                    className="flex flex-wrap items-end gap-3 border-b border-border pb-4 print:hidden"
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="text-text-mute">As of (exclusive)</span>
                        <input
                            type="date"
                            name="asOf"
                            defaultValue={fmtDate(asOf)}
                            className="h-9 rounded-lg border border-border bg-surface px-2 text-sm"
                        />
                    </label>
                    <button className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-sm font-medium hover:bg-surface-2">
                        Apply
                    </button>
                    <div className="ml-auto text-xs text-text-mute">
                        Includes all ledger entries through {asOfLabel}
                    </div>
                </form>

                {/* OBE coverage note — plain wording. If a shop
                    imported opening balances, name the number so an
                    owner reading the balance sheet doesn't see
                    equity they can't explain. */}
                {s.openingBalanceEquity !== 0 ? (
                    <div className="rounded-lg border border-info-500/40 bg-info-50 px-4 py-3 text-sm text-info-700 dark:border-info-500/30 dark:bg-info-500/10 dark:text-info-500">
                        <div className="font-medium">
                            Equity includes {money(s.openingBalanceEquity)} carried in from a
                            previous system.
                        </div>
                        <div className="mt-1 text-xs">
                            This is what your customers owed you, what you owed suppliers,
                            what was on the shelf, and cash in the till when the shop
                            switched to GarageOS. Shown as a separate equity line so it
                            stays distinct from what the shop has earned since.
                        </div>
                    </div>
                ) : null}

                {/* Coverage banner — same shape as the P&L. Cumulative
                    across all time (not period). */}
                {s.coverage.cogsFlagOff && s.accumulatedProfit > 0 ? (
                    <div className="rounded-lg border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        <div className="font-medium">Cost tracking is off for this garage.</div>
                        <div className="mt-1 text-xs">
                            Accumulated profit below overstates by the parts-cost of every
                            invoice raised so far. Until cost tracking is switched on,
                            Cost of Goods Sold shows AED 0 and the equity line inherits that gap.
                        </div>
                    </div>
                ) : null}
                {!s.coverage.cogsFlagOff &&
                s.coverage.invoicesTotal > 0 &&
                s.coverage.invoicesCosted < s.coverage.invoicesTotal ? (
                    <div className="rounded-lg border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        <div className="text-base font-semibold">
                            {s.coverage.invoicesCosted} of {s.coverage.invoicesTotal} invoices
                            costed ({coveragePct}%)
                        </div>
                        <div className="mt-1 text-xs">
                            The equity line overstates by the parts-cost of the{" "}
                            {s.coverage.invoicesTotal - s.coverage.invoicesCosted} uncosted
                            invoice(s) since the shop&apos;s books began. Same reason the P&amp;L
                            reports inflated profit.
                        </div>
                    </div>
                ) : null}

                {/* Balance sheet — Assets side / Liabilities + Equity side */}
                <section>
                    <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-mute">
                        Balance sheet
                    </h3>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <BalanceSheetSide
                            title="Assets"
                            rows={assetRows.map((r) => ({ account: r.account, amount: r.balance }))}
                            total={s.assets}
                        />
                        <div className="flex flex-col gap-4">
                            <BalanceSheetSide
                                title="Liabilities"
                                rows={liabilityRows.map((r) => ({ account: r.account, amount: r.balance }))}
                                total={s.liabilities}
                            />
                            <BalanceSheetSide
                                title="Equity"
                                rows={[
                                    ...(s.openingBalanceEquity !== 0
                                        ? [{
                                            account: "Opening Balance Equity (carried in)",
                                            amount: s.openingBalanceEquity,
                                        }]
                                        : []),
                                    {
                                        account: "Accumulated profit (all time, derived)",
                                        amount: s.accumulatedProfit,
                                    },
                                ]}
                                total={totalEquity}
                            />
                            <div className="rounded-lg border border-border/60 bg-surface-2/40 px-3 py-2 text-sm">
                                <div className="flex items-baseline justify-between font-semibold">
                                    <span>Liabilities + Equity</span>
                                    <span className="tabular-nums">
                                        {money(totalLiabilitiesAndEquity)}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {s.outOfBalanceBy === 0 ? (
                        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
                            ✓ Balanced: Assets = Liabilities + Equity.
                        </p>
                    ) : (
                        <div className="mt-2 rounded-lg border border-danger-500/40 bg-danger-50 px-4 py-3 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
                            <div className="font-semibold">
                                Out of balance by {money(s.outOfBalanceBy)}
                            </div>
                            <div className="mt-1 text-xs">
                                Every ledger post should be balanced (DR = CR). A non-zero
                                delta here means one side of a pair is missing, wrong, or
                                the ledger has been touched outside the app. Investigate
                                before treating the equity line as trustworthy.
                            </div>
                        </div>
                    )}

                    <p className="mt-3 text-xs text-text-mute">
                        Equity is a derived figure — accumulated profit since the shop&apos;s
                        books began, computed as Revenue − Cost of Goods Sold − Expenses.
                        No closing entries are posted, so the number stays consistent as
                        historical invoices are added or corrected.
                    </p>
                </section>

                {/* Trial balance — every account, DR + CR columns */}
                <section className="border-t border-border pt-6">
                    <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-mute">
                        Trial balance
                    </h3>
                    {s.rows.length === 0 ? (
                        <p className="text-sm text-text-mute">No activity yet.</p>
                    ) : (
                        <div className="overflow-hidden rounded-lg border border-border">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-wide text-text-mute">
                                        <th className="px-3 py-2 text-start font-semibold">Account</th>
                                        <th className="px-3 py-2 text-start font-semibold">Type</th>
                                        <th className="px-3 py-2 text-end font-semibold">Debits</th>
                                        <th className="px-3 py-2 text-end font-semibold">Credits</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {s.rows.map((row) => (
                                        <tr key={row.account} className="border-b border-border/60 last:border-0">
                                            <td className="px-3 py-2">{row.account}</td>
                                            <td className="px-3 py-2 text-xs text-text-mute">{row.type}</td>
                                            <td className="px-3 py-2 text-end tabular-nums">
                                                {row.debit > 0 ? money(row.debit) : ""}
                                            </td>
                                            <td className="px-3 py-2 text-end tabular-nums">
                                                {row.credit > 0 ? money(row.credit) : ""}
                                            </td>
                                        </tr>
                                    ))}
                                    <tr className="border-t-2 border-border bg-surface-2/60">
                                        <td className="px-3 py-2 font-semibold" colSpan={2}>
                                            Totals
                                        </td>
                                        <td className="px-3 py-2 text-end tabular-nums font-semibold">
                                            {money(s.totalDebits)}
                                        </td>
                                        <td className="px-3 py-2 text-end tabular-nums font-semibold">
                                            {money(s.totalCredits)}
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="mt-2 text-xs text-text-mute">
                        Sum of Debits must equal Sum of Credits — that&apos;s the ledger&apos;s own
                        consistency check. If they don&apos;t, the underlying data has a bug
                        that will also make the balance sheet not balance.
                    </p>
                </section>

                {/* Revenue + expense recap — same numbers the P&L shows,
                    but here they feed the derived equity above. */}
                {revenueRows.length > 0 || expenseRows.length > 0 ? (
                    <section className="border-t border-border pt-6">
                        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-mute">
                            Feeding accumulated profit
                        </h3>
                        <div className="grid gap-3 sm:grid-cols-2">
                            {revenueRows.length > 0 ? (
                                <BalanceSheetSide
                                    title="Revenue (all time)"
                                    rows={revenueRows.map((r) => ({ account: r.account, amount: r.balance }))}
                                    total={revenueRows.reduce((s, r) => s + r.balance, 0)}
                                />
                            ) : (
                                <div />
                            )}
                            {expenseRows.length > 0 ? (
                                <BalanceSheetSide
                                    title="COGS &amp; Expenses (all time)"
                                    rows={expenseRows.map((r) => ({ account: r.account, amount: r.balance }))}
                                    total={expenseRows.reduce((s, r) => s + r.balance, 0)}
                                />
                            ) : null}
                        </div>
                    </section>
                ) : null}
            </div>
        </main>
    );
}

function BalanceSheetSide({
    title,
    rows,
    total,
}: {
    title: string;
    rows: { account: string; amount: number }[];
    total: number;
}) {
    return (
        <div className="rounded-lg border border-border/60 bg-surface-2/30 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-mute">
                {title}
            </div>
            {rows.length === 0 ? (
                <p className="py-1 text-sm text-text-mute">—</p>
            ) : (
                <>
                    {rows.map((r) => (
                        <div
                            key={r.account}
                            className="flex items-baseline justify-between border-b border-border/40 py-1 text-sm last:border-0"
                        >
                            <span>{r.account}</span>
                            <span className="tabular-nums">
                                {r.amount < 0 ? `−AED ${Math.abs(r.amount).toFixed(2)}` : `AED ${r.amount.toFixed(2)}`}
                            </span>
                        </div>
                    ))}
                    <div className="mt-2 flex items-baseline justify-between border-t border-border/60 pt-2 text-sm font-semibold">
                        <span>Total {title}</span>
                        <span className="tabular-nums">
                            {total < 0 ? `−AED ${Math.abs(total).toFixed(2)}` : `AED ${total.toFixed(2)}`}
                        </span>
                    </div>
                </>
            )}
        </div>
    );
}
