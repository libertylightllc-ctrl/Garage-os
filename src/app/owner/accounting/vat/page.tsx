import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { PrintButton } from "@/components/print-button";
import { computeVatSummary } from "@/lib/vat-summary";

/** AR: negative deltas render as "−AED 1500.00", never "AED -1500.00". */
function money(n: number): string {
    if (n < 0) return `−AED ${Math.abs(n).toFixed(2)}`;
    return `AED ${n.toFixed(2)}`;
}

export const dynamic = "force-dynamic";

/**
 * VAT Summary — E4 (AR 2026-09-02).
 *
 * Reads LedgerEntry via computeVatSummary(). Owner-only, financial
 * reporting bucket. Date range from URL with quarterly presets;
 * defaults to the current calendar quarter.
 *
 * Copy discipline: we produce the figures, we don't file. Every
 * mention of the return names the FTA portal as the filing surface.
 *
 * Coverage banner (rule 12 pattern):
 *   • cogsFlag off analogue for expenses — if the period has ACTIVE
 *     expenses but none carry VAT, the reclaim is under-reported.
 *     The banner surfaces it in plain wording.
 *   • Supplier bills coverage is informational only — Payables C3
 *     enforces VAT capture at receive-form time, so a zero-VAT bill
 *     is a deliberate operator choice, not an omission.
 */
export default async function VatSummaryPage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string; to?: string }>;
}) {
    const session = await requireRole("OWNER");
    const params = await searchParams;

    // Default: current calendar quarter. UAE VAT filing is quarterly
    // for most shops; the operator can widen or narrow via the form.
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

    // Quarter presets — links with different query strings.
    const quarterStart = (year: number, q: number) =>
        fmtDate(new Date(Date.UTC(year, q * 3, 1)));
    const quarterEnd = (year: number, q: number) =>
        fmtDate(new Date(Date.UTC(year, q * 3 + 3, 1)));
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
                new Date(
                    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
                ),
            ),
        },
    ];

    const expenseCoveragePct =
        vat.coverage.expensesTotal > 0
            ? Math.round((vat.coverage.expensesWithVat / vat.coverage.expensesTotal) * 100)
            : null;
    const noExpenseVat =
        vat.coverage.expensesTotal > 0 && vat.coverage.expensesWithVat === 0;
    const partialExpenseVat =
        vat.coverage.expensesTotal > 0 &&
        vat.coverage.expensesWithVat > 0 &&
        vat.coverage.expensesWithVat < vat.coverage.expensesTotal;

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

                {/* Date range form + quarter presets */}
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

                {/* Coverage banner — plain wording, prominent count.
                    Two conditions:
                      1. No expenses in the period carry VAT → the
                         reclaim is under-reported.
                      2. Partial — some do, some don't. Legitimate,
                         but flag it so the operator can review. */}
                {noExpenseVat ? (
                    <div className="rounded-lg border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        <div className="text-base font-semibold">
                            None of {vat.coverage.expensesTotal} expense
                            {vat.coverage.expensesTotal === 1 ? "" : "s"} in this period
                            carry a VAT amount
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

                {/* The three headline numbers */}
                <section className="grid gap-3 sm:grid-cols-3">
                    <NumberCard label="Output VAT" sublabel="collected from invoices" amount={vat.outputVat} />
                    <NumberCard label="Input VAT" sublabel="paid on purchases + expenses" amount={vat.inputVat} />
                    <NumberCard
                        label={vat.netPayable >= 0 ? "Net VAT payable" : "Net VAT refund"}
                        sublabel={
                            vat.netPayable >= 0
                                ? "owed to the FTA"
                                : "reclaimable from the FTA"
                        }
                        amount={Math.abs(vat.netPayable)}
                        emphasize
                    />
                </section>

                {/* Working breakdown — accountants want to see the
                    two-line arithmetic below the headline. */}
                <section className="rounded-lg border border-border/60 bg-surface-2/30 p-4 text-sm">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-mute">
                        Working
                    </h3>
                    <div className="flex items-baseline justify-between border-b border-border/40 py-1">
                        <span>Output VAT (Sales Revenue × 5%, from invoices)</span>
                        <span className="tabular-nums">{money(vat.outputVat)}</span>
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

                {/* Coverage footer — always visible, even at 100%.
                    Same pattern as the P&L: the operator needs to know
                    the denominator, not just the ratio. */}
                <section className="rounded-lg border border-border/60 bg-surface-2/30 p-4 text-xs">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-mute">
                        Coverage
                    </h3>
                    <div className="flex flex-wrap gap-x-6 gap-y-1">
                        <span>
                            Expenses:{" "}
                            <span className="tabular-nums font-medium text-text">
                                {vat.coverage.expensesWithVat} of {vat.coverage.expensesTotal}
                            </span>{" "}
                            carry VAT
                        </span>
                        <span>
                            Supplier bills:{" "}
                            <span className="tabular-nums font-medium text-text">
                                {vat.coverage.supplierBillsWithVat} of {vat.coverage.supplierBillsTotal}
                            </span>{" "}
                            carry VAT
                        </span>
                    </div>
                </section>

                {/* Filing reminder — always visible, prints too.
                    A printed VAT summary that leaves the office without
                    this note is the document that gets treated as a
                    return. Rule 13 print discipline applies here. */}
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

function NumberCard({
    label,
    sublabel,
    amount,
    emphasize,
}: {
    label: string;
    sublabel: string;
    amount: number;
    emphasize?: boolean;
}) {
    return (
        <div
            className={`rounded-lg border p-4 ${emphasize ? "border-border bg-surface-2/60" : "border-border/60 bg-surface-2/30"}`}
        >
            <div className="text-xs font-semibold uppercase tracking-wide text-text-mute">
                {label}
            </div>
            <div className="text-xs text-text-mute">{sublabel}</div>
            <div
                className={`mt-2 tabular-nums ${emphasize ? "text-2xl font-bold" : "text-xl font-semibold"}`}
            >
                {amount < 0 ? `−AED ${Math.abs(amount).toFixed(2)}` : `AED ${amount.toFixed(2)}`}
            </div>
        </div>
    );
}
