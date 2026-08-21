import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { companyGarageIds } from "@/lib/branches";
import { getT } from "@/i18n/server";
import { computePartProfit, type PartProfitRow } from "@/lib/part-profit";
import { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

// Per-part profit report (AR 2026-08-22, profit reporting Step 7).
//
// Splits every part that sold in the range into two tables:
//   Earners            profit > 0, biggest first
//   Break-even/losing  profit ≤ 0, biggest loss first
//
// A part whose ANY invoice line lacks unitCost shows "—" for cost /
// profit / margin — the same discipline that governs computeJobProfit
// and the per-period widget. A coverage badge on the row makes the
// signal explicit ("Unknown" plus "3 of 5 lines have cost data" is
// more useful than just a blank).

const VALID_DAYS = new Set([7, 14, 30, 90, 365]);

const money = (v: Prisma.Decimal | null): string =>
    v === null ? "—" : `AED ${Number(v).toFixed(2)}`;
const qty = (v: Prisma.Decimal): string => Number(v).toFixed(0);
const pct = (v: number | null): string => (v === null ? "—" : `${v}%`);

export default async function OwnerAnalyticsParts({
    searchParams,
}: {
    searchParams: Promise<{ days?: string }>;
}) {
    const session = await requireRole("OWNER");
    const t = await getT();
    const gids = await companyGarageIds(session.user.garageId);
    const { days: rawDays } = await searchParams;
    const days = (() => {
        const n = Number(rawDays);
        return Number.isFinite(n) && VALID_DAYS.has(n) ? n : 30;
    })();

    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const rows = await computePartProfit(gids, from, now);

    // Split: earners (profit > 0) and losers (profit <= 0). Rows with
    // NULL profit (coverage < 100%) go to a THIRD table below the
    // earners/losers split — we can't classify them either way
    // honestly, and burying them would defeat the spec's coverage
    // discipline.
    const earners: PartProfitRow[] = [];
    const losers: PartProfitRow[] = [];
    const unknowns: PartProfitRow[] = [];
    for (const r of rows) {
        if (r.profit === null) unknowns.push(r);
        else if (Number(r.profit) > 0) earners.push(r);
        else losers.push(r);
    }
    // Earners: largest profit first. Losers: worst loss first (most
    // negative). Both give the owner "the row that matters most" at
    // row 1.
    earners.sort((a, b) => Number(b.profit!) - Number(a.profit!));
    losers.sort((a, b) => Number(a.profit!) - Number(b.profit!));
    // Unknowns: biggest revenue first — the ones costing the most
    // visibility to leave uncovered.
    unknowns.sort((a, b) => Number(b.revenue) - Number(a.revenue));

    return (
        <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6 lg:max-w-6xl xl:max-w-7xl">
            <AppNav role="OWNER" active="analytics" />
            <div>
                <h1 className="text-2xl font-semibold tracking-tight">
                    {t("partProfitTitle")}
                </h1>
                <p className="text-sm text-text-mute">
                    {t("partProfitSubtitle")}
                </p>
            </div>

            {/* Window selector — mirrors /owner/analytics for consistency. */}
            <div className="flex flex-wrap items-center gap-3">
                <div
                    role="tablist"
                    aria-label={t("analyticsWindowSelector")}
                    className="inline-flex w-fit items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
                >
                    {[7, 14, 30, 90, 365].map((n) => {
                        const isActive = n === days;
                        return (
                            <Link
                                key={n}
                                href={`/owner/analytics/parts?days=${n}`}
                                role="tab"
                                aria-selected={isActive}
                                className={
                                    "inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-semibold tabular-nums transition-colors " +
                                    (isActive
                                        ? "bg-surface text-text shadow-sm dark:bg-brand-900 dark:text-white"
                                        : "text-text-mute hover:bg-surface hover:text-text dark:hover:bg-brand-900/40")
                                }
                            >
                                {n}d
                            </Link>
                        );
                    })}
                </div>
                <Link
                    href={`/owner/analytics?days=${days}`}
                    className="text-sm text-text-mute underline underline-offset-2 hover:text-text"
                >
                    ← {t("partProfitBackToAnalytics")}
                </Link>
            </div>

            {rows.length === 0 ? (
                <p className="rounded-2xl border border-border bg-surface-2 p-6 text-sm text-text-mute">
                    {t("partProfitEmpty")}
                </p>
            ) : (
                <>
                    <PartTable
                        title={t("partProfitEarners")}
                        subtitle={t("partProfitEarnersSubtitle")}
                        rows={earners}
                        emptyText={t("partProfitEarnersEmpty")}
                    />
                    <PartTable
                        title={t("partProfitLosers")}
                        subtitle={t("partProfitLosersSubtitle")}
                        rows={losers}
                        emptyText={t("partProfitLosersEmpty")}
                        loserVariant
                    />
                    {unknowns.length > 0 ? (
                        <PartTable
                            title={t("partProfitUnknowns")}
                            subtitle={t("partProfitUnknownsSubtitle")}
                            rows={unknowns}
                            emptyText={""}
                        />
                    ) : null}
                </>
            )}

            <p className="text-xs text-text-mute">
                {t("periodProfitFootnote")}
            </p>
        </main>
    );
}

function PartTable({
    title,
    subtitle,
    rows,
    emptyText,
    loserVariant = false,
}: {
    title: string;
    subtitle: string;
    rows: PartProfitRow[];
    emptyText: string;
    loserVariant?: boolean;
}) {
    return (
        <section className="rounded-2xl border border-border bg-surface p-4">
            <div className="mb-3">
                <h2 className="text-base font-semibold">{title}</h2>
                <p className="text-xs text-text-mute">{subtitle}</p>
            </div>
            {rows.length === 0 ? (
                <p className="text-sm text-text-mute">{emptyText}</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-text-mute">
                            <tr>
                                <th className="py-2 pr-3">Part</th>
                                <th className="py-2 pr-3 text-right">Qty sold</th>
                                <th className="py-2 pr-3 text-right">Revenue</th>
                                <th className="py-2 pr-3 text-right">Cost</th>
                                <th className="py-2 pr-3 text-right">Profit</th>
                                <th className="py-2 pr-3 text-right">Margin</th>
                                <th className="py-2 pr-3 text-right">Coverage</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => {
                                const profitClass =
                                    r.profit === null
                                        ? "text-text-mute"
                                        : Number(r.profit) > 0
                                          ? "text-emerald-700 dark:text-emerald-300"
                                          : Number(r.profit) < 0
                                            ? "text-rose-700 dark:text-rose-300"
                                            : "";
                                return (
                                    <tr
                                        key={r.key}
                                        className="border-b border-border/50 last:border-b-0"
                                    >
                                        <td className="py-2 pr-3">
                                            <div className="font-medium">{r.name}</div>
                                        </td>
                                        <td className="py-2 pr-3 text-right tabular-nums">
                                            {qty(r.qtySold)}
                                        </td>
                                        <td className="py-2 pr-3 text-right tabular-nums">
                                            {money(r.revenue)}
                                        </td>
                                        <td className="py-2 pr-3 text-right tabular-nums">
                                            {money(r.cost)}
                                        </td>
                                        <td
                                            className={
                                                "py-2 pr-3 text-right tabular-nums font-medium " +
                                                profitClass
                                            }
                                        >
                                            {money(r.profit)}
                                        </td>
                                        <td
                                            className={
                                                "py-2 pr-3 text-right tabular-nums " +
                                                profitClass
                                            }
                                        >
                                            {pct(r.marginPct)}
                                        </td>
                                        <td className="py-2 pr-3 text-right">
                                            <CoverageBadge
                                                pct={r.coveragePct}
                                                covered={r.linesCovered}
                                                total={r.linesTotal}
                                            />
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {loserVariant && rows.length > 0 ? (
                <p className="mt-2 text-xs text-text-mute">
                    These parts are selling at or below their weighted-average
                    cost. Common causes: catalogue price out of date, cost
                    inflated by a recent expensive receipt, or a real
                    loss-leader you meant to keep at cost.
                </p>
            ) : null}
        </section>
    );
}

function CoverageBadge({
    pct,
    covered,
    total,
}: {
    pct: number;
    covered: number;
    total: number;
}) {
    const cls =
        pct === 100
            ? "border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-200"
            : pct >= 50
              ? "border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-200"
              : "border-rose-300 text-rose-800 dark:border-rose-800 dark:text-rose-200";
    return (
        <span
            className={
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium tabular-nums " +
                cls
            }
            title={`${covered} of ${total} invoice lines have cost data`}
        >
            {pct}%
        </span>
    );
}
