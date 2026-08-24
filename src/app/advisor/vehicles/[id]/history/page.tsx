import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { PrintButton } from "@/components/print-button";
import { DocumentHeader } from "@/components/document-header";
import { CostVisibilityToggle } from "@/components/cost-visibility-toggle";
import { loadVehicleHistory } from "@/lib/vehicle-history";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
 * Printable vehicle-history lookup (AR 2026-08-25, Batch A).
 *
 * Every job on ONE vehicle: date, mileage, work done, parts fitted,
 * cost, status. Screen-first (advisor's most-used lookup) with clean
 * print CSS via the `data-print-document` wrapper.
 *
 * Guard: ADVISOR + OWNER + MASTER. Same shape as the existing
 * /advisor/vehicles/[id] surface. Garage scope enforced inside
 * loadVehicleHistory() by joining Vehicle.customer.garageId.
 * notFound() on miss so cross-garage existence never leaks via
 * status code.
 *
 * Cost + margin visibility (AR 2026-08-25):
 *   - Never rendered on print (data-print-omit-cost + the print
 *     media query in CostVisibilityToggle).
 *   - Off by default on screen — the toggle enables them. This
 *     document ends up in a customer's hand more than any other
 *     printable in the app, so the safe default is the safe view.
 *
 * Owner-at-job-time:
 *   - When the vehicle has never been transferred, no owner tag on
 *     any row.
 *   - When it has, each row shows the owner who was on the vehicle
 *     when that JC was opened. Prevents an advisor from reading
 *     history through the wrong owner's lens.
 */
export default async function VehicleHistoryPrintablePage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ showCost?: string }>;
}) {
    const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
    const { id } = await params;
    const sp = await searchParams;
    const t = await getT();
    const locale = await getLocale();

    // Server-side cost gate. ?showCost=1 → the loader fetches +
    // returns cost/margin. Anything else → the loader returns null
    // for every cost field, and the numbers never enter the HTML.
    // AR 2026-08-25 verify — replaces the client-side CSS toggle.
    const showCost = sp.showCost === "1";

    const history = await loadVehicleHistory(id, session.user.garageId, showCost);
    if (!history) notFound();

    // Country falls back to UAE — every prod garage today is UAE and
    // the schema keeps `country` nullable only for the intake step
    // before the setup wizard has run. DocumentHeader requires a
    // non-null string here.
    const country = history.garage.country ?? "UAE";
    const tz = countryToTimeZone(country);

    // Newest first for on-screen reading; matches how an advisor
    // scans a returning car ("what was done last time"). Chronological
    // storage in the loader kept the ownership walk simple.
    const entries = [...history.entries].reverse();

    // Any mileage anomaly anywhere in the history triggers a top-of-
    // page note (in addition to the per-row dagger), so someone
    // scanning a long history doesn't have to spot a marker
    // mid-table. Both are visible on screen and print. AR 2026-08-25.
    const hasMileageAnomaly = history.entries.some((e) => e.mileageDecreased);

    return (
        <main
            data-print-document="vehicle-history"
            className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6"
        >
            <AppNav role="ADVISOR" active="vehicles" />

            <div className="flex flex-col gap-3 print:hidden sm:flex-row sm:items-center sm:justify-between">
                <Link
                    href={`/advisor/vehicles/${history.vehicle.id}`}
                    className="inline-block py-2 text-sm text-text-mute hover:underline"
                >
                    ← {t("vehicleHistoryBack")}
                </Link>
                <div className="flex items-center gap-2">
                    <CostVisibilityToggle
                        basePath={`/advisor/vehicles/${id}/history`}
                        currentParams={sp}
                        showCost={showCost}
                    />
                    <PrintButton className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2">
                        🖨 {t("printLabel")}
                    </PrintButton>
                </div>
            </div>

            {/* Document header — same shape as every other printable
                surface (job card, estimate, invoice, PO). */}
            <DocumentHeader
                title={t("vehicleHistoryTitle")}
                jobCard={null}
                vehicle={history.vehicle}
                garage={{
                    name: history.garage.name,
                    trn: history.garage.trn,
                    country,
                }}
                logoUrl={history.garage.logoUrl ?? "/brand/garageos-logo.png"}
            />

            {/* Current owner + "changed hands" flag. The flag is
                belt-and-braces alongside the per-row ownerAtJobTime
                tags — makes it obvious at first glance that not
                every row in the table belongs to the person named
                below. */}
            <div className="rounded-xl border border-border bg-surface p-4">
                <div className="text-xs uppercase tracking-wide text-text-mute">
                    {t("vehicleHistoryCurrentOwner")}
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-base font-semibold">{history.currentOwner.name}</span>
                    <span className="text-sm font-mono tabular-nums text-text-mute">
                        {history.currentOwner.phone}
                    </span>
                    {history.hasChangedHands ? (
                        <span className="rounded-full border border-warning-500/40 bg-warning-50 px-2 py-0.5 text-[11px] font-semibold text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                            ⚠️ {t("vehicleHistoryChangedHands")}
                        </span>
                    ) : null}
                </div>
                {history.hasChangedHands ? (
                    <ul className="mt-3 flex flex-col gap-1 text-xs text-text-mute">
                        {history.transfers.map((tr, i) => (
                            <li key={i}>
                                {fmtDate(tr.at, locale, tz)} · {tr.fromCustomerName}{" "}
                                <span aria-hidden>→</span> {tr.toCustomerName}
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>

            {/* Top-of-page mileage-anomaly summary. Rendered when ANY
                row in the history is flagged, so a scanner of a long
                history doesn't have to spot the dagger mid-table.
                Neutral wording, plain text, no colour or emoji. On
                paper this row prints in the natural document flow;
                no border/background so a black-and-white printer
                doesn't render a phantom box. AR 2026-08-25. */}
            {hasMileageAnomaly ? (
                <p className="rounded border border-border bg-surface-2 px-3 py-2 text-sm print:border-0 print:bg-transparent print:px-0">
                    <strong>{t("vehicleHistoryMileageNoteHeading")}</strong>{" "}
                    {t("vehicleHistoryMileageNoteBody")}
                </p>
            ) : null}

            {/* Body table. Cost + margin cells carry `data-cost-cell`
                (toggle-hidden by default) AND `data-print-omit-cost`
                (globally hidden on print). Either rule alone suffices;
                both together survive any cascade fight. */}
            {entries.length === 0 ? (
                <p className="rounded-xl border border-border bg-surface-2 p-4 text-center text-sm text-text-mute">
                    {t("vehicleHistoryEmpty")}
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] border-collapse text-sm">
                        <thead className="bg-surface-2 text-xs uppercase tracking-wide text-text-mute">
                            <tr>
                                <th className="px-2 py-2 text-left">{t("vehicleHistoryColDate")}</th>
                                <th className="px-2 py-2 text-left">{t("vehicleHistoryColJc")}</th>
                                <th className="px-2 py-2 text-right">{t("vehicleHistoryColMileage")}</th>
                                <th className="px-2 py-2 text-left">{t("vehicleHistoryColWork")}</th>
                                <th className="px-2 py-2 text-left">{t("vehicleHistoryColParts")}</th>
                                <th className="px-2 py-2 text-right">{t("vehicleHistoryColRevenue")}</th>
                                {/* Cost/margin columns only render when
                                    the URL param says so. Off-state
                                    HTML doesn't contain the numbers at
                                    all — server-side gate, not a CSS
                                    hide. AR 2026-08-25 verify. Print
                                    also strips them via
                                    [data-print-omit-cost] as
                                    belt-and-braces for the show-state. */}
                                {showCost ? (
                                    <>
                                        <th className="px-2 py-2 text-right" data-print-omit-cost>
                                            {t("vehicleHistoryColCost")}
                                        </th>
                                        <th className="px-2 py-2 text-right" data-print-omit-cost>
                                            {t("vehicleHistoryColMargin")}
                                        </th>
                                    </>
                                ) : null}
                                <th className="px-2 py-2 text-left">{t("vehicleHistoryColStatus")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map((e) => (
                                <tr key={e.jobCardId} className="border-t border-border align-top">
                                    <td className="px-2 py-2 whitespace-nowrap">
                                        {fmtDate(e.date, locale, tz)}
                                    </td>
                                    <td className="px-2 py-2 whitespace-nowrap font-mono tabular-nums">
                                        {e.jobNumber != null ? `JC-${e.jobNumber}` : "—"}
                                        {e.ownerAtJobTime ? (
                                            <div className="mt-0.5 text-[10px] font-normal text-text-mute">
                                                {e.ownerAtJobTime.name}
                                            </div>
                                        ) : null}
                                    </td>
                                    <td className="px-2 py-2 text-right tabular-nums">
                                        {e.mileageIn != null ? (
                                            <>
                                                {e.mileageIn.toLocaleString(locale)}
                                                {/* Mileage-decrease marker.
                                                    Neutral wording per AR
                                                    2026-08-25 — no accusatory
                                                    "warning" chip, no emoji,
                                                    no colour dependency (a
                                                    printed page can be b&w).
                                                    Dagger + footnote at the
                                                    bottom of the page. */}
                                                {e.mileageDecreased ? (
                                                    <sup className="ml-1 font-semibold tabular-nums">†</sup>
                                                ) : null}
                                            </>
                                        ) : (
                                            "—"
                                        )}
                                    </td>
                                    <td className="px-2 py-2">
                                        {e.complaint ? (
                                            <div className="text-xs text-text-mute">{e.complaint}</div>
                                        ) : null}
                                        {e.workDoneLines.length > 0 ? (
                                            <ul className="mt-1 list-disc pl-4 text-xs">
                                                {e.workDoneLines.map((l, i) => (
                                                    <li key={i}>{l}</li>
                                                ))}
                                            </ul>
                                        ) : null}
                                    </td>
                                    <td className="px-2 py-2">
                                        {e.partsFitted.length > 0 ? (
                                            <ul className="list-disc pl-4 text-xs">
                                                {e.partsFitted.map((p, i) => (
                                                    <li key={i}>{p}</li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <span className="text-xs text-text-mute">—</span>
                                        )}
                                    </td>
                                    <td className="px-2 py-2 text-right tabular-nums">
                                        {e.revenue != null ? (
                                            <>
                                                {money(e.revenue)}
                                                {e.source === "estimate" ? (
                                                    <div className="text-[10px] text-text-mute">
                                                        {t("vehicleHistoryEstimatedNotInvoiced")}
                                                    </div>
                                                ) : null}
                                                {e.outstanding != null && e.outstanding > 0 ? (
                                                    <div className="text-[10px] text-warning-700 dark:text-warning-500">
                                                        {t("vehicleHistoryUnpaid")}: {money(e.outstanding)}
                                                    </div>
                                                ) : null}
                                            </>
                                        ) : (
                                            <span className="text-text-mute">—</span>
                                        )}
                                    </td>
                                    {showCost ? (
                                        <>
                                            <td className="px-2 py-2 text-right tabular-nums" data-print-omit-cost>
                                                {e.cost != null ? money(e.cost) : <span className="text-text-mute">—</span>}
                                            </td>
                                            <td className="px-2 py-2 text-right tabular-nums" data-print-omit-cost>
                                                {e.margin != null ? money(e.margin) : <span className="text-text-mute">—</span>}
                                            </td>
                                        </>
                                    ) : null}
                                    <td className="px-2 py-2">
                                        {/* Raw JobStatus — the vocabulary an
                                            advisor uses day-to-day (DELIVERED,
                                            CANCELLED, ON_HOLD, etc.). Not
                                            piped through friendlyStatus
                                            because per-row context (claimedBy,
                                            latestEstimateStatus) isn't
                                            loaded in this projection and
                                            an accurate friendly label needs
                                            those. */}
                                        <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px]">
                                            {e.status}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className="border-t-2 border-border bg-surface-2 font-semibold">
                            <tr>
                                <td colSpan={5} className="px-2 py-2 text-right text-xs uppercase tracking-wide text-text-mute">
                                    {t("vehicleHistoryTotalsLabel")} · {history.totals.visits} {t("vehicleHistoryVisits")}
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums">
                                    {money(history.totals.lifetimeRevenue)}
                                    {history.totals.outstandingBalance > 0 ? (
                                        <div className="text-[10px] font-normal text-warning-700 dark:text-warning-500">
                                            {t("vehicleHistoryUnpaid")}: {money(history.totals.outstandingBalance)}
                                        </div>
                                    ) : null}
                                </td>
                                {showCost ? (
                                    <>
                                        <td className="px-2 py-2 text-right tabular-nums" data-print-omit-cost>
                                            {money(history.totals.lifetimeCost)}
                                        </td>
                                        <td className="px-2 py-2 text-right tabular-nums" data-print-omit-cost>
                                            {money(history.totals.lifetimeMargin)}
                                        </td>
                                    </>
                                ) : null}
                                <td />
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}

            {/* Footnote for the dagger mark on flagged rows. Rendered
                only when at least one row is flagged; visible on
                screen and print. AR 2026-08-25. */}
            {hasMileageAnomaly ? (
                <p className="text-xs text-text-mute">
                    <sup className="font-semibold">†</sup>{" "}
                    {t("vehicleHistoryMileageFootnote")}
                </p>
            ) : null}
        </main>
    );
}
