// Money-at-a-glance tiles on /owner. AR 2026-08-30.
//
// Owner-only surface — the profit tile double-guards via
// canSeeMargin(role). Every value is ledger-derived (see
// src/lib/owner-dashboard.ts head comment) so what the shop
// owner sees agrees with what the accountant sees in ERPNext.
// If those two ever diverge, that's a bug worth surfacing, not
// a number to smooth over.

import {
    cashReceived,
    revenueMonth,
    unpaidInvoicesAging,
    grossProfitMonth,
    jobsCompletedMonth,
    type MonthPair,
    type AgingBuckets,
    type GrossProfit,
} from "@/lib/owner-dashboard";
import { canSeeMargin } from "@/lib/permissions";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";

type T = (k: MessageKey) => string;

const money = (n: number) => `AED ${n.toFixed(2)}`;
const fill = (tpl: string, vars: Record<string, string>): string =>
    tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

function trendPct(pair: MonthPair): { pct: number; direction: "up" | "down" | "flat" } {
    if (pair.lastMonthSameWindow <= 0) {
        return {
            pct: pair.thisMonth > 0 ? 100 : 0,
            direction: pair.thisMonth > 0 ? "up" : "flat",
        };
    }
    const delta = pair.thisMonth - pair.lastMonthSameWindow;
    const pct = Math.round((delta / pair.lastMonthSameWindow) * 100);
    return {
        pct: Math.abs(pct),
        direction: pct === 0 ? "flat" : pct > 0 ? "up" : "down",
    };
}

function Trend({ pair, invert = false, t }: { pair: MonthPair; invert?: boolean; t: T }) {
    const { pct, direction } = trendPct(pair);
    if (direction === "flat") {
        return <span className="text-text-mute">{t("dashTrendFlat")}</span>;
    }
    // "invert" flips the tone — for cash/revenue/jobs, up is good;
    // for outstanding-debt-style metrics up would be bad. Currently
    // only the four positive metrics use this component; kept for
    // future symmetry.
    const isGood = invert ? direction === "down" : direction === "up";
    const tone = isGood ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400";
    const tpl = direction === "up" ? t("dashTrendUp") : t("dashTrendDown");
    return <span className={tone}>{fill(tpl, { pct: String(pct) })}</span>;
}

function Tile({
    label,
    value,
    subtext,
    tone = "default",
}: {
    label: string;
    value: React.ReactNode;
    subtext?: React.ReactNode;
    tone?: "default" | "warning";
}) {
    const border =
        tone === "warning"
            ? "border-amber-500/30 dark:border-amber-500/20"
            : "border-border";
    return (
        <div className={`flex flex-col gap-1 rounded-xl border ${border} bg-surface p-4 shadow-sm`}>
            <div className="text-xs font-medium text-text-mute">{label}</div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
            {subtext ? <div className="text-xs text-text-mute">{subtext}</div> : null}
        </div>
    );
}

function CashTile({ v, t }: { v: MonthPair; t: T }) {
    return (
        <Tile
            label={t("dashCashLabel")}
            value={money(v.thisMonth)}
            subtext={<Trend pair={v} t={t} />}
        />
    );
}

function RevenueTile({ v, t }: { v: MonthPair; t: T }) {
    return (
        <Tile
            label={t("dashRevenueLabel")}
            value={money(v.thisMonth)}
            subtext={<Trend pair={v} t={t} />}
        />
    );
}

function JobsTile({ v, t }: { v: MonthPair; t: T }) {
    return (
        <Tile
            label={t("dashJobsLabel")}
            value={String(v.thisMonth)}
            subtext={<Trend pair={v} t={t} />}
        />
    );
}

function UnpaidTile({ v, t }: { v: AgingBuckets; t: T }) {
    return (
        <Tile
            label={t("dashUnpaidLabel")}
            value={money(v.total)}
            subtext={
                <div className="mt-1 grid grid-cols-4 gap-1 text-xs">
                    <div>
                        <div className="text-text-mute">{t("dashAgingCurrent")}</div>
                        <div className="tabular-nums font-medium">{money(v.current)}</div>
                    </div>
                    <div>
                        <div className="text-text-mute">{t("dashAging1_30")}</div>
                        <div className="tabular-nums font-medium">{money(v.days30)}</div>
                    </div>
                    <div>
                        <div className="text-text-mute">{t("dashAging31_60")}</div>
                        <div className="tabular-nums font-medium">{money(v.days60)}</div>
                    </div>
                    <div>
                        <div className="text-text-mute">{t("dashAging61plus")}</div>
                        <div className="tabular-nums font-medium">{money(v.days90plus)}</div>
                    </div>
                </div>
            }
        />
    );
}

function ProfitTile({ v, t }: { v: GrossProfit; t: T }) {
    if (v.state === "incomplete") {
        return (
            <Tile
                label={t("dashProfitLabel")}
                value={
                    <span className="text-text-mute">
                        {t("dashProfitIncompleteValue")}
                    </span>
                }
                subtext={
                    <span>
                        {fill(t("dashProfitIncompleteSub"), {
                            missing: String(v.invoicesMissingCost),
                            total: String(v.invoicesTotal),
                            revenue: money(v.revenue),
                        })}
                    </span>
                }
                tone="warning"
            />
        );
    }
    return (
        <Tile
            label={t("dashProfitLabel")}
            value={money(v.profit)}
            subtext={
                <span>
                    {fill(t("dashProfitCompleteSub"), {
                        margin: v.marginPct.toFixed(1),
                        costed: String(v.invoicesCosted),
                        total: String(v.invoicesTotal),
                    })}
                </span>
            }
        />
    );
}

export async function DashboardTiles({
    garageId,
    role,
    now = new Date(),
}: {
    garageId: string;
    role: string;
    now?: Date;
}) {
    const t = await getT();
    // Fetch all five in parallel — every source query is
    // garage-scoped and independent. No transaction needed since
    // this is a read-only snapshot for display.
    const showProfit = canSeeMargin(role);
    const [cash, revenue, unpaid, profit, jobs] = await Promise.all([
        cashReceived(garageId, now),
        revenueMonth(garageId, now),
        unpaidInvoicesAging(garageId, now),
        showProfit ? grossProfitMonth(garageId, now) : Promise.resolve(null),
        jobsCompletedMonth(garageId, now),
    ]);

    return (
        <section
            aria-label="Money at a glance"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
        >
            <CashTile v={cash} t={t} />
            <RevenueTile v={revenue} t={t} />
            <UnpaidTile v={unpaid} t={t} />
            {profit ? <ProfitTile v={profit} t={t} /> : null}
            <JobsTile v={jobs} t={t} />
        </section>
    );
}
