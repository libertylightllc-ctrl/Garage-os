import Link from "next/link";
import type { Prisma } from "@/generated/prisma/client";
import type { JobProfit } from "@/lib/job-profit";
import type { getT } from "@/i18n/server";

/**
 * Per-job profit card (AR 2026-08-12 profit reporting Step 5;
 * incomplete-coverage render tightened AR 2026-08-13 after the card
 * was shown returning Cost=AED 0.00 / Margin=100% on a job whose
 * parts coverage was 0-of-5 — the exact fake-zero we designed
 * against).
 *
 * Advisor / Owner / Master only. GATED BY THE CALLER via
 * canSeeMargin(role) — this component does NOT check the role itself
 * so it stays a pure presenter. Never rendered on any customer surface
 * (customer allowlists in /c/invoice/[id] and /c/estimate/[id] omit
 * cost + markup fields at the DB level; belt-and-braces).
 *
 * Rendering discipline for incomplete coverage:
 *   - Cost, Profit, and Margin render as em-dashes when the compute
 *     layer returns null. computeJobProfit nulls a side's cost /
 *     profit / margin the moment ANY line in that side lacks data.
 *   - Revenue is always shown — it's known from lineTotal regardless
 *     of whether cost was ever recorded.
 *   - Labour box shows revenue even when cost is unknown (a labour
 *     line at AED 200 is real money; hiding it because the rate isn't
 *     set was the second bug AR called out).
 */

interface JobProfitCardProps {
    profit: JobProfit;
    t: Awaited<ReturnType<typeof getT>>;
    /**
     * Whether the garage currently has a labour hourly rate configured.
     * Distinguishes "no rate set → point owner to settings" from "old
     * rows with no snapshot". Today they overlap (Step 4 is the first
     * write), but the affordance differs.
     */
    hasLabourRate: boolean;
    /** Where to send the owner when they need to set the labour rate. */
    settingsHref?: string;
    className?: string;
}

const DASH = "—";

/** money(v) — em-dash when null, "AED X.YY" otherwise. */
function money(d: Prisma.Decimal | null): string {
    if (d === null) return DASH;
    return `AED ${d.toFixed(2)}`;
}

/** pct(v) — em-dash when null, "X.Y%" otherwise. */
function pct(d: Prisma.Decimal | null): string {
    if (d === null) return DASH;
    return `${d.toFixed(1)}%`;
}

export function JobProfitCard(props: JobProfitCardProps) {
    const { profit, t, hasLabourRate, settingsHref = "/settings", className } = props;
    const c = profit.coverage;

    const partsCoverageText = t("profitCardCoverageParts")
        .replace("{covered}", String(c.partsCovered))
        .replace("{total}", String(c.partsTotal));
    const laborCoverageText = t("profitCardCoverageLabour")
        .replace("{covered}", String(c.laborCovered))
        .replace("{total}", String(c.laborTotal));

    // Coverage discipline. When a side is incomplete, its cost /
    // profit / margin come from the compute layer as null and
    // render as em-dashes. Coverage line explains why.
    const partsIncomplete = c.partsTotal > 0 && c.partsCovered < c.partsTotal;
    const laborIncomplete = c.laborTotal > 0 && c.laborCovered < c.laborTotal;

    return (
        <section
            className={
                "rounded-xl border border-border bg-surface-2 p-4 text-sm print:hidden " +
                (className ?? "")
            }
            data-testid="job-profit-card"
            aria-label={t("profitCardTitle")}
        >
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-mute">
                {t("profitCardTitle")}
            </h2>

            {/* Headline: Revenue → Cost → Gross profit + margin.
                Cost / gross / margin are em-dashes when either side is
                incomplete — a computed number would be wrong by an
                unknown amount, which the owner reads as authoritative.
                Revenue is always shown. */}
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 tabular-nums">
                <dt className="text-text-mute">{t("profitCardRevenue")}</dt>
                <dd className="text-end">{money(profit.revenue)}</dd>

                <dt className="text-text-mute">{t("profitCardCost")}</dt>
                <dd className="text-end">{money(profit.totalCost)}</dd>

                <dt className="text-base font-semibold">{t("profitCardGross")}</dt>
                <dd className="text-end text-base font-semibold">
                    {money(profit.grossProfit)}
                    <span className="ms-2 text-sm font-normal text-text-mute">
                        · {t("profitCardMargin")} {pct(profit.grossMarginPct)}
                    </span>
                </dd>
            </dl>

            {/* Coverage banner for the headline. When either side is
                incomplete, the em-dashes above need an explanation
                the owner can act on — otherwise it just looks broken.
                Rendered as its own bordered alert row (matches the
                warning tone of the labour-rate CTA below) with real
                padding + margin, so on narrow viewports the two-line
                wrap doesn't visually crowd the Parts / Labour boxes
                (AR cosmetic report 2026-08-13 — the plain-paragraph
                version got clipped by the boxes underneath). */}
            {(partsIncomplete || laborIncomplete) && (
                <div
                    role="status"
                    className="mt-3 rounded-lg border border-warning-500/40 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500"
                >
                    {t("profitCardHeadlineIncomplete")}
                </div>
            )}

            {/* Split — Parts + Labour. Each carries its own coverage line
                so the owner sees the confidence next to the number.
                Bumped from mt-4 → mt-5 so the boxes sit clearly below
                the headline (and below the coverage banner when it's
                present), matching the visual rhythm of the rest of
                the card. */}
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {/* Parts side. Hidden entirely when the job has no
                    parts revenue AND no parts lines — nothing to say. */}
                {(c.partsTotal > 0 || !profit.partsRevenue.isZero()) && (
                    <div className="rounded-lg border border-border/60 bg-surface p-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-text-mute">
                            {t("profitCardParts")}
                        </div>
                        <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs tabular-nums">
                            <dt className="text-text-mute">{t("profitCardRevenue")}</dt>
                            <dd className="text-end">{money(profit.partsRevenue)}</dd>
                            <dt className="text-text-mute">{t("profitCardCost")}</dt>
                            <dd className="text-end">{money(profit.partsCost)}</dd>
                            <dt className="font-medium">{t("profitCardMargin")}</dt>
                            <dd className="text-end font-medium">
                                {pct(profit.partsMarginPct)}
                            </dd>
                        </dl>
                        {c.partsTotal > 0 && (
                            <p
                                className={
                                    "mt-2 text-xs " +
                                    (partsIncomplete
                                        ? "text-warning-700 dark:text-warning-500"
                                        : "text-text-mute")
                                }
                            >
                                {partsCoverageText}
                            </p>
                        )}
                    </div>
                )}

                {/* Labour side. Rendered whenever there is labour
                    revenue OR at least one work session — either is
                    a fact worth showing.
                    Revenue is ALWAYS visible (AR 2026-08-13: "labour
                    revenue is missing entirely from the card" —
                    hiding the AED 200 labour line because the rate
                    isn't set was the bug).
                    Cost + margin come from the compute layer with
                    coverage discipline: em-dash if incomplete OR if
                    the rate isn't set. When the rate is missing AND
                    sessions exist, a CTA below the numbers points
                    the owner at settings. */}
                {(c.laborTotal > 0 || !profit.laborRevenue.isZero()) && (
                    <div className="rounded-lg border border-border/60 bg-surface p-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-text-mute">
                            {t("profitCardLabour")}
                        </div>
                        <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs tabular-nums">
                            <dt className="text-text-mute">{t("profitCardRevenue")}</dt>
                            <dd className="text-end">{money(profit.laborRevenue)}</dd>
                            <dt className="text-text-mute">{t("profitCardCost")}</dt>
                            <dd className="text-end">{money(profit.laborCost)}</dd>
                            <dt className="font-medium">{t("profitCardMargin")}</dt>
                            <dd className="text-end font-medium">
                                {pct(profit.laborMarginPct)}
                            </dd>
                        </dl>
                        {c.laborTotal > 0 && (
                            <p
                                className={
                                    "mt-2 text-xs " +
                                    (laborIncomplete
                                        ? "text-warning-700 dark:text-warning-500"
                                        : "text-text-mute")
                                }
                            >
                                {laborCoverageText}
                            </p>
                        )}
                        {c.laborTotal > 0 && !hasLabourRate && (
                            <div className="mt-2 flex flex-col gap-2">
                                <p className="text-xs text-warning-700 dark:text-warning-500">
                                    {t("profitCardLabourRateMissing")}
                                </p>
                                <Link
                                    href={settingsHref}
                                    className="inline-flex w-fit items-center rounded-md border border-warning-500/40 bg-warning-50 px-2 py-1 text-xs font-semibold text-warning-700 hover:bg-warning-100 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500"
                                >
                                    {t("profitCardLabourRateMissingCta")} →
                                </Link>
                            </div>
                        )}
                        {c.laborTotal === 0 && !profit.laborRevenue.isZero() && (
                            <p className="mt-2 text-xs text-text-mute">
                                {t("profitCardNoLabourSessions")}
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* Footnotes — what these numbers actually mean.
                AR 2026-08-12: labour is the configured rate × time,
                not cash out the door (matters for salaried shops);
                parts cost is the weighted average, not per-unit. */}
            <ul className="mt-3 flex flex-col gap-1 text-[11px] leading-snug text-text-mute">
                <li>· {t("profitCardNotePartsCost")}</li>
                <li>· {t("profitCardNoteLabourCost")}</li>
            </ul>
        </section>
    );
}
