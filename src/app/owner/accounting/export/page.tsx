import { requireRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Accounting export — owner-side download page (AR 2026-08-23).
 *
 * Five CSV downloads + a pointer at the chart-of-accounts mapping doc.
 * Date-range default = current month (accountants work in periods; a
 * full-history export is an explicit deliberate choice, not the miss-
 * a-param outcome).
 *
 * Guard: OWNER only. Per the spec (CLAUDE.md), financial reporting
 * pages stay OWNER-only — MASTER is barred from this surface because
 * the export contains the entire financial position of the business.
 *
 * Every download route (/api/accounting/export?file=...) writes one
 * row to AccountingExportLog before serving the file. Nothing else
 * on this page or its downstream route mutates business data.
 */
export default async function AccountingExportPage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string; to?: string }>;
}) {
    await requireRole("OWNER");
    const t = await getT();
    const sp = await searchParams;

    // Default range: first of current month (UTC) → today (UTC). The
    // UI form pre-fills these; the API route enforces the same
    // default when params are absent or malformed.
    const now = new Date();
    const isoDate = (d: Date) => d.toISOString().slice(0, 10);
    const defaultFrom = isoDate(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    );
    const defaultTo = isoDate(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    );
    const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : defaultFrom;
    const to = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : defaultTo;

    const files: Array<{ key: string; labelKey: string; descKey: string }> = [
        { key: "chart-of-accounts", labelKey: "acctExportChartLabel", descKey: "acctExportChartDesc" },
        { key: "journal", labelKey: "acctExportJournalLabel", descKey: "acctExportJournalDesc" },
        { key: "invoices", labelKey: "acctExportInvoicesLabel", descKey: "acctExportInvoicesDesc" },
        { key: "payments", labelKey: "acctExportPaymentsLabel", descKey: "acctExportPaymentsDesc" },
        { key: "customers", labelKey: "acctExportCustomersLabel", descKey: "acctExportCustomersDesc" },
    ] as const;

    return (
        <main className="mx-auto max-w-3xl p-4 pb-24">
            <AppNav role="OWNER" active="accounting" />
            <h1 className="mt-4 text-xl font-semibold">{t("acctExportHeading")}</h1>
            <p className="mt-1 text-sm text-text-mute">{t("acctExportIntro")}</p>

            {/* Date-range form — GET so a bookmark of a specific range works. */}
            <form method="GET" className="mt-4 flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs text-text-mute">
                    {t("acctExportFromLabel")}
                    <input
                        type="date"
                        name="from"
                        defaultValue={from}
                        className="rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono tabular-nums"
                    />
                </label>
                <label className="flex flex-col gap-1 text-xs text-text-mute">
                    {t("acctExportToLabel")}
                    <input
                        type="date"
                        name="to"
                        defaultValue={to}
                        className="rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono tabular-nums"
                    />
                </label>
                <button
                    type="submit"
                    className="inline-flex h-10 items-center justify-center rounded-lg bg-brand-900 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
                >
                    {t("acctExportApplyRange")}
                </button>
            </form>

            <ul className="mt-6 flex flex-col gap-2">
                {files.map((f) => (
                    <li
                        key={f.key}
                        className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <div>
                            <div className="text-sm font-semibold">{t(f.labelKey as never)}</div>
                            <div className="mt-0.5 text-xs text-text-mute">{t(f.descKey as never)}</div>
                        </div>
                        <a
                            href={`/api/accounting/export?file=${f.key}&from=${from}&to=${to}`}
                            className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold hover:bg-surface-3"
                        >
                            ⤓ {t("acctExportDownloadCta")}
                        </a>
                    </li>
                ))}
            </ul>

            <p className="mt-6 rounded-lg border border-border bg-surface-2 px-4 py-3 text-xs text-text-mute">
                {t("acctExportMappingPointer")}
            </p>
        </main>
    );
}
