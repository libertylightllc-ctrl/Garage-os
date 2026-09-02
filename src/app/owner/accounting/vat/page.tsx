import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { PrintButton } from "@/components/print-button";
import { computeVatSummary } from "@/lib/vat-summary";
import { EMIRATE_LABEL } from "@/lib/emirate";

/** AR: negative deltas render as "−AED 1500.00", never "AED -1500.00". */
function money(n: number): string {
    if (n < 0) return `−AED ${Math.abs(n).toFixed(2)}`;
    return `AED ${n.toFixed(2)}`;
}

function emirateLabel(bucket: string): string {
    if (bucket === "Unassigned") return "Unassigned";
    return EMIRATE_LABEL[bucket as keyof typeof EMIRATE_LABEL] ?? bucket;
}

export const dynamic = "force-dynamic";

/**
 * VAT summary — E4 + E4b (AR 2026-09-02 / 2026-09-03).
 *
 * Reads LedgerEntry via computeVatSummary(). Owner-only. Date range
 * from URL with quarterly presets; defaults to the current calendar
 * quarter.
 *
 * Table shape matches Form 201's per-emirate section: rows for each
 * emirate that had activity in the period (in Form 201 order), plus
 * an "Unassigned" row when null-emirate invoices touched the period.
 * Columns: Standard-rated supplies (net + VAT) and Adjustments (net
 * + VAT). See rule 14 for the Standard-vs-Adjustments split rules.
 *
 * Copy discipline: we produce the figures, we don't file. Every
 * mention of the return names the FTA portal as the filing surface.
 */
export default async function VatSummaryPage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string; to?: string }>;
}) {
    const session = await requireRole("OWNER");
    const params = await searchParams;

    const now = new Date();
    const currentQuarter = Math.floor(now.getUTCMonth() / 3);
    const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), currentQuarter * 3, 1));
    const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), currentQuarter * 3 + 3, 1));
    const fromDate = params.from ? new Date(params.from + "T00:00:00Z") : defaultFrom;
    const toDate = params.to ? new Date(params.to + "T00:00:00Z") : defaultTo;
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        throw new Error("Invalid date range");
    }

    const vat = await computeVatSummary(session.user.garageId, fromDate, toDate);

    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
    const rangeLabel = `${fmtDate(fromDate)} → ${fmtDate(new Date(toDate.getTime() - 1))}`;

    const quarterStart = (year: number, q: number) => fmtDate(new Date(Date.UTC(year, q * 3, 1)));
    const quarterEnd = (year: number, q: number) => fmtDate(new Date(Date.UTC(year, q * 3 + 3, 1)));
    const prevQ = currentQuarter === 0 ? 3 : currentQuarter - 1;
    const prevQYear = currentQuarter === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    const presets = [
        {
            label: `Q${currentQuarter + 1} ${now.getUTCFullYear()}`,
            from: quarterStart(now.getUTCFullYear(), currentQuarter),
            to: quarterEnd(now.getUTCFullYear(), currentQuarter),
        },
        {
            label: `Q${prevQ + 1} ${prevQYear}`,
            from: quarterStart(prevQYear, prevQ),
            to: quarterEnd(prevQYear, prevQ),
        },
        {
            label: "Year to date",
            from: fmtDate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1))),
            to: fmtDate(
                new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)),
            ),
        },
    ];

    const expenseCoveragePct =
        vat.coverage.expensesTotal > 0
            ? Math.round((vat.coverage.expensesWithVat / vat.coverage.expensesTotal) * 100)
            : null;
    const noExpenseVat = vat.coverage.expensesTotal > 0 && vat.coverage.expensesWithVat === 0;
    const partialExpenseVat =
        vat.coverage.expensesTotal > 0 &&
        vat.coverage.expensesWithVat > 0 &&
        vat.coverage.expensesWithVat < vat.coverage.expensesTotal;
    const unassignedInvoices =
        vat.coverage.invoicesInPeriod > 0 &&
        vat.coverage.invoicesWithEmirate < vat.coverage.invoicesInPeriod;
    const missingEmirateCount =
        vat.coverage.invoicesInPeriod - vat.coverage.invoicesWithEmirate;

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
                        · VAT summary
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight">VAT summary</h1>
                    <p className="mt-1 max-w-2xl text-sm text-text-mute">
                        The figures your accountant needs for Form 201. This page produces the
                        numbers — the return itself is filed on the{" "}
                        <a
                            href="https://tax.gov.ae/"
                            target="_blank"
                            rel="noreferrer"
                            className="underline hover:text-text"
                        >
                            FTA portal
                        </a>
                        .
                    </p>
                </div>
                <PrintButton className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-sm font-medium hover:bg-surface-2 print:hidden">
                    Print
                </PrintButton>
            </div>

            <div
                className="flex flex-col gap-6 rounded-xl border border-border bg-surface p-6 print:border-none print:bg-transparent print:p-0"
                data-print-document="vat-summary"
            >
                <div className="hidden print:block">
                    <h2 className="text-lg font-semibold">VAT summary</h2>
                    <p className="text-xs text-text-mute">
                        {rangeLabel} · figures only — filing happens on the FTA portal
                    </p>
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
                        {presets.map((p) => (
                            <Link
                                key={p.label}
                                href={`/owner/accounting/vat?from=${p.from}&to=${p.to}`}
                                className="rounded-lg border border-border px-2 py-1 hover:bg-surface-2"
                            >
                                {p.label}
                            </Link>
                        ))}
                    </div>
                </form>

                {/* Coverage banners — plain wording, load-bearing count.
                    Three conditions, evaluated independently:
                      1. Any invoice without an emirate → the Standard
                         row has an "Unassigned" bucket the accountant
                         can't post to a Form 201 box.
                      2. No expenses carry VAT → reclaim under-reported.
                      3. Partial expense VAT coverage → operator review. */}
                {unassignedInvoices ? (
                    <div className="rounded-lg border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        <div className="text-base font-semibold">
                            {missingEmirateCount} of {vat.coverage.invoicesInPeriod} invoice
                            {vat.coverage.invoicesInPeriod === 1 ? "" : "s"} in this period
                            {" "}don&apos;t have an emirate assigned
                        </div>
                        <div className="mt-1 text-xs">
                            Their VAT lands in an &quot;Unassigned&quot; row below — Form 201 has no
                            box for that. Set the emirate in{" "}
                            <Link href="/settings" className="underline">
                                Settings
                            </Link>
                            , then void + reissue the invoices to update the snapshot. Pre-cutover
                            invoices carry an inferred value from the garage&apos;s current setting.
                        </div>
                    </div>
                ) : null}
                {noExpenseVat ? (
                    <div className="rounded-lg border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        <div className="text-base font-semibold">
                            None of {vat.coverage.expensesTotal} expense
                            {vat.coverage.expensesTotal === 1 ? "" : "s"} in this period carry
                            a VAT amount
                        </div>
                        <div className="mt-1 text-xs">
                            Zero VAT on every expense usually means nobody entered the split
                            when recording them — the reclaimable input VAT is under-reported.
                            Review the expenses on the Expenses page and re-record any that
                            actually carried VAT on the supplier tax invoice.
                        </div>
                    </div>
                ) : partialExpenseVat ? (
                    <div className="rounded-lg border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        <div className="text-base font-semibold">
                            {vat.coverage.expensesWithVat} of {vat.coverage.expensesTotal} expenses
                            carry VAT ({expenseCoveragePct}%)
                        </div>
                        <div className="mt-1 text-xs">
                            The rest were recorded with zero VAT. That&apos;s legitimate for
                            salaries, most bank charges, and any supplier who didn&apos;t invoice
                            VAT — but if any of the zero-VAT rows should have carried it, the
                            reclaim above is under-reported.
                        </div>
                    </div>
                ) : null}

                {/* Per-emirate table — the seven-box display. Rows are
                    only emitted for emirates with activity in the
                    period. Empty period = no rows + a plain note. */}
                <section>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-mute">
                        Standard-rated supplies by emirate (Form 201, boxes 1a–1g)
                    </h3>
                    {vat.byEmirate.length === 0 ? (
                        <p className="text-sm text-text-mute">
                            No standard-rated supplies or adjustments in this period.
                        </p>
                    ) : (
                        <div className="overflow-hidden rounded-lg border border-border">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-wide text-text-mute">
                                        <th className="px-3 py-2 text-start font-semibold">Emirate</th>
                                        <th className="px-3 py-2 text-end font-semibold">Standard VAT</th>
                                        <th className="px-3 py-2 text-end font-semibold">Adjustments</th>
                                        <th className="px-3 py-2 text-end font-semibold">Net VAT</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {vat.byEmirate.map((row) => (
                                        <tr
                                            key={row.emirate}
                                            className={`border-b border-border/60 last:border-0 ${row.emirate === "Unassigned" ? "bg-warning-50 dark:bg-warning-500/10" : ""}`}
                                        >
                                            <td className="px-3 py-2">
                                                {emirateLabel(row.emirate)}
                                                {row.emirate === "Unassigned" ? (
                                                    <span className="ms-2 text-xs text-warning-700 dark:text-warning-500">
                                                        no Form 201 box
                                                    </span>
                                                ) : null}
                                            </td>
                                            <td className="px-3 py-2 text-end tabular-nums">
                                                {money(row.standardVat)}
                                            </td>
                                            <td className="px-3 py-2 text-end tabular-nums">
                                                {row.adjustmentVat === 0 ? "—" : money(row.adjustmentVat)}
                                            </td>
                                            <td className="px-3 py-2 text-end tabular-nums font-medium">
                                                {money(row.netVat)}
                                            </td>
                                        </tr>
                                    ))}
                                    <tr className="border-t-2 border-border bg-surface-2/60">
                                        <td className="px-3 py-2 font-semibold">Total</td>
                                        <td className="px-3 py-2 text-end tabular-nums font-semibold">
                                            {money(vat.outputVat)}
                                        </td>
                                        <td className="px-3 py-2 text-end tabular-nums font-semibold">
                                            {vat.adjustmentsVat === 0 ? "—" : money(vat.adjustmentsVat)}
                                        </td>
                                        <td className="px-3 py-2 text-end tabular-nums font-semibold">
                                            {money(vat.outputVat - vat.adjustmentsVat)}
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="mt-2 text-xs text-text-mute">
                        Standard = VAT on invoices raised this period. Adjustments = VAT on
                        voids reversing prior-quarter invoices; posted to the ORIGINAL invoice&apos;s
                        emirate (see rule 14).
                    </p>
                </section>

                {/* Bottom-line arithmetic */}
                <section className="rounded-lg border border-border/60 bg-surface-2/30 p-4 text-sm">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-mute">
                        Working
                    </h3>
                    <div className="flex items-baseline justify-between border-b border-border/40 py-1">
                        <span>Output VAT (standard-rated supplies × 5%, this period)</span>
                        <span className="tabular-nums">{money(vat.outputVat)}</span>
                    </div>
                    <div className="flex items-baseline justify-between border-b border-border/40 py-1">
                        <span>Less: Adjustments (prior-period voids)</span>
                        <span className="tabular-nums">{money(vat.adjustmentsVat)}</span>
                    </div>
                    <div className="flex items-baseline justify-between border-b border-border/40 py-1">
                        <span>Less: Input VAT (reclaimable on purchases + expenses)</span>
                        <span className="tabular-nums">{money(vat.inputVat)}</span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between py-1 font-semibold">
                        <span>
                            {vat.netPayable >= 0
                                ? "Net VAT payable to FTA"
                                : "Net VAT refund from FTA"}
                        </span>
                        <span className="tabular-nums">{money(vat.netPayable)}</span>
                    </div>
                </section>

                <section className="rounded-lg border border-border/60 bg-surface-2/30 p-4 text-xs">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-mute">
                        Coverage
                    </h3>
                    <div className="flex flex-wrap gap-x-6 gap-y-1">
                        <span>
                            Invoices with emirate:{" "}
                            <span className="tabular-nums font-medium text-text">
                                {vat.coverage.invoicesWithEmirate} of {vat.coverage.invoicesInPeriod}
                            </span>
                        </span>
                        <span>
                            Expenses with VAT:{" "}
                            <span className="tabular-nums font-medium text-text">
                                {vat.coverage.expensesWithVat} of {vat.coverage.expensesTotal}
                            </span>
                        </span>
                        <span>
                            Supplier bills with VAT:{" "}
                            <span className="tabular-nums font-medium text-text">
                                {vat.coverage.supplierBillsWithVat} of {vat.coverage.supplierBillsTotal}
                            </span>
                        </span>
                    </div>
                </section>

                <section className="rounded-lg border border-border/60 bg-surface-2/30 p-4 text-xs text-text-mute">
                    <div className="font-medium text-text">This is a working summary, not a return.</div>
                    <div className="mt-1">
                        Form 201 is filed on the{" "}
                        <a
                            href="https://tax.gov.ae/"
                            target="_blank"
                            rel="noreferrer"
                            className="underline hover:text-text print:no-underline"
                        >
                            FTA portal
                        </a>
                        . The figures above are what your accountant transcribes into the boxes
                        there; corrections and adjustments happen on the portal, not here.
                    </div>
                </section>
            </div>
        </main>
    );
}
