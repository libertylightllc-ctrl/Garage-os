import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { PrintButton } from "@/components/print-button";
import { computePurchaseSummary } from "@/lib/purchase-summary";

/** AR: negative deltas render as "−AED 1500.00", never "AED -1500.00". */
function money(n: number): string {
    if (n < 0) return `−AED ${Math.abs(n).toFixed(2)}`;
    return `AED ${n.toFixed(2)}`;
}
function moneyOrDash(n: number | null): string {
    return n === null ? "—" : money(n);
}

export const dynamic = "force-dynamic";

/**
 * Purchase summary — E6 (AR 2026-09-03).
 *
 * Operator surface: "what did I buy and what did I pay." Owner +
 * MASTER, not OWNER-only — this sits with Payables + Purchasing +
 * Inventory as MASTER-open, unlike the P&L / VAT / Trial-Balance
 * financial-reporting bucket.
 *
 * Reads LedgerEntry for the money numbers (rule 15 / 13 / 14
 * discipline). By-part detail joins through PartMovement's captured
 * unitCost snapshot. Direct-fit spend surfaces in the coverage
 * banner so an owner comparing the two doesn't lose track of the
 * gap.
 */
export default async function PurchaseSummaryPage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string; to?: string }>;
}) {
    const session = await requireAnyRole(["OWNER", "MASTER"]);
    const params = await searchParams;

    const now = new Date();
    const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const fromDate = params.from ? new Date(params.from + "T00:00:00Z") : defaultFrom;
    const toDate = params.to ? new Date(params.to + "T00:00:00Z") : defaultTo;
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        throw new Error("Invalid date range");
    }

    const p = await computePurchaseSummary(session.user.garageId, fromDate, toDate);
    const role = session.user.role as "OWNER" | "MASTER";

    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
    const rangeLabel = `${fmtDate(fromDate)} → ${fmtDate(new Date(toDate.getTime() - 1))}`;

    const monthStart = (offset: number) =>
        fmtDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)));
    const today = fmtDate(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)),
    );
    const yearStart = fmtDate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
    const presets = [
        { label: "Month to date", from: monthStart(0), to: today },
        { label: "Last month", from: monthStart(-1), to: monthStart(0) },
        { label: "Year to date", from: yearStart, to: today },
    ];

    // Coverage banner logic:
    //   - Direct-fit spend > 0 → gap on the by-part breakdown.
    //   - Uncosted movements > 0 → gap even within stock.
    // Both conditions are informational; the top-line "purchased"
    // number is authoritative for the AP-side story. The gap is
    // about attribution: which parts and which spend line up.
    const gapVsTotal = p.totalPurchased - p.coverage.byPartSpendCovered;
    const showDirectFit = p.coverage.directFitSpend > 0;
    const showUncosted = p.coverage.uncostedMovementCount > 0;

    return (
        <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
            <div className="print:hidden">
                <AppNav role={role} active="accounting" />
            </div>

            <div className="flex items-baseline justify-between gap-4 print:hidden">
                <div>
                    <div className="text-xs text-text-mute">
                        <Link href="/owner/accounting" className="hover:underline">
                            Accounting
                        </Link>{" "}
                        · Purchases
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight">Purchases</h1>
                    <p className="mt-1 max-w-2xl text-sm text-text-mute">
                        What you bought and what you paid, by supplier and by part. Payables
                        covers outstanding balances; this page is the &quot;where did the money
                        go&quot; view for a shop owner.
                    </p>
                </div>
                <PrintButton className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-sm font-medium hover:bg-surface-2 print:hidden">
                    Print
                </PrintButton>
            </div>

            <div
                className="flex flex-col gap-6 rounded-xl border border-border bg-surface p-6 print:border-none print:bg-transparent print:p-0"
                data-print-document="purchases"
            >
                <div className="hidden print:block">
                    <h2 className="text-lg font-semibold">Purchases</h2>
                    <p className="text-xs text-text-mute">{rangeLabel}</p>
                </div>

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
                        {presets.map((pr) => (
                            <Link
                                key={pr.label}
                                href={`/owner/accounting/purchases?from=${pr.from}&to=${pr.to}`}
                                className="rounded-lg border border-border px-2 py-1 hover:bg-surface-2"
                            >
                                {pr.label}
                            </Link>
                        ))}
                    </div>
                </form>

                {/* Coverage banner — plain wording. */}
                {showDirectFit || showUncosted ? (
                    <div className="rounded-lg border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        <div className="text-base font-semibold">
                            By-part breakdown covers {money(p.coverage.byPartSpendCovered)} of{" "}
                            {money(p.totalPurchased)} purchased{" "}
                            {p.totalPurchased > 0
                                ? `(${Math.round((p.coverage.byPartSpendCovered / p.totalPurchased) * 100)}%)`
                                : ""}
                        </div>
                        {showDirectFit ? (
                            <div className="mt-1 text-xs">
                                Direct-fit spend: <strong>{money(p.coverage.directFitSpend)}</strong> across{" "}
                                {p.coverage.directFitReceiptCount} receipt
                                {p.coverage.directFitReceiptCount === 1 ? "" : "s"} — parts delivered
                                straight to a customer&apos;s job, not through stock. They aren&apos;t
                                on the by-part list below and don&apos;t flow through the supplier
                                totals up top.
                            </div>
                        ) : null}
                        {showUncosted ? (
                            <div className="mt-1 text-xs">
                                {p.coverage.uncostedMovementCount} stock receive
                                {p.coverage.uncostedMovementCount === 1 ? " has" : "s have"} no unit
                                cost recorded (received before per-movement cost snapshots existed).
                                Those parts show a quantity but no spend — marked with &quot;—&quot; below.
                            </div>
                        ) : null}
                        {gapVsTotal > 0.01 && !showDirectFit ? (
                            <div className="mt-1 text-xs">
                                Difference between the two totals ({money(gapVsTotal)}) is stock
                                receives whose unit cost wasn&apos;t captured.
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {/* Top-line totals */}
                <section className="grid gap-3 sm:grid-cols-2">
                    <NumberCard label="Purchased" sublabel="from suppliers on account (AP)" amount={p.totalPurchased} />
                    <NumberCard label="Paid" sublabel="to suppliers this period" amount={p.totalPaid} />
                </section>

                {/* By supplier */}
                <section>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-mute">
                        By supplier
                    </h3>
                    {p.bySupplier.length === 0 ? (
                        <p className="text-sm text-text-mute">
                            No supplier activity in this period.
                        </p>
                    ) : (
                        <div className="overflow-hidden rounded-lg border border-border">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-wide text-text-mute">
                                        <th className="px-3 py-2 text-start font-semibold">Supplier</th>
                                        <th className="px-3 py-2 text-end font-semibold">Purchased</th>
                                        <th className="px-3 py-2 text-end font-semibold">Paid</th>
                                        <th className="px-3 py-2 text-end font-semibold">Outstanding</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {p.bySupplier.map((row) => (
                                        <tr
                                            key={row.supplierId}
                                            className="border-b border-border/60 last:border-0"
                                        >
                                            <td className="px-3 py-2">{row.supplierName}</td>
                                            <td className="px-3 py-2 text-end tabular-nums">
                                                {money(row.purchased)}
                                            </td>
                                            <td className="px-3 py-2 text-end tabular-nums">
                                                {money(row.paid)}
                                            </td>
                                            <td className="px-3 py-2 text-end tabular-nums font-medium">
                                                {money(row.outstanding)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="mt-2 text-xs text-text-mute">
                        Outstanding is the current unpaid balance across all bills (not just this
                        period). Purchased and Paid are period totals.
                    </p>
                </section>

                {/* By part */}
                <section>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-mute">
                        By part (stock receives)
                    </h3>
                    {p.byPart.length === 0 ? (
                        <p className="text-sm text-text-mute">
                            No stock receives in this period.
                            {p.coverage.directFitReceiptCount > 0
                                ? " (Direct-fit receipts are listed in the coverage banner above.)"
                                : ""}
                        </p>
                    ) : (
                        <div className="overflow-hidden rounded-lg border border-border">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-wide text-text-mute">
                                        <th className="px-3 py-2 text-start font-semibold">Part</th>
                                        <th className="px-3 py-2 text-end font-semibold">Qty</th>
                                        <th className="px-3 py-2 text-end font-semibold">Spend</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {p.byPart.map((row) => (
                                        <tr
                                            key={row.partId}
                                            className={`border-b border-border/60 last:border-0 ${row.hasUncostedMovements ? "bg-warning-50/40 dark:bg-warning-500/5" : ""}`}
                                        >
                                            <td className="px-3 py-2">
                                                <div className="font-medium">{row.name}</div>
                                                {row.sku ? (
                                                    <div className="text-xs text-text-mute tabular-nums">
                                                        {row.sku}
                                                    </div>
                                                ) : null}
                                            </td>
                                            <td className="px-3 py-2 text-end tabular-nums">
                                                {row.qty}
                                            </td>
                                            <td className="px-3 py-2 text-end tabular-nums">
                                                {moneyOrDash(row.spend)}
                                                {row.hasUncostedMovements ? (
                                                    <div className="text-xs text-warning-700 dark:text-warning-500">
                                                        under-reports
                                                    </div>
                                                ) : null}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="mt-2 text-xs text-text-mute">
                        Qty and Spend net returns against receives on the same part.
                        Direct-fit parts (delivered straight to a customer&apos;s job, no stock
                        movement) are counted separately in the coverage banner.
                    </p>
                </section>
            </div>
        </main>
    );
}

function NumberCard({
    label,
    sublabel,
    amount,
}: {
    label: string;
    sublabel: string;
    amount: number;
}) {
    return (
        <div className="rounded-lg border border-border/60 bg-surface-2/30 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-text-mute">
                {label}
            </div>
            <div className="text-xs text-text-mute">{sublabel}</div>
            <div className="mt-2 text-xl font-semibold tabular-nums">{money(amount)}</div>
        </div>
    );
}
