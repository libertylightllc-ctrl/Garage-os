import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { PrintButton } from "@/components/print-button";
import { DocumentHeader } from "@/components/document-header";
import { CostVisibilityToggle } from "@/components/cost-visibility-toggle";
import { loadCustomerStatement } from "@/lib/customer-statement";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { formatInvoiceNo } from "@/lib/billing";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;
// Signed variant for the net-balance line — a customer-in-credit
// reads "−AED 200.00" (currency sign OUTSIDE the sign, per AR
// convention pinned in memory).
const moneySigned = (n: number) => (n < 0 ? `−AED ${(-n).toFixed(2)}` : `AED ${n.toFixed(2)}`);

/**
 * Printable customer statement (AR 2026-08-25, Batch B).
 *
 * All-vehicles / all-invoices AR view for one customer, with days-
 * past-due aging and a net balance owed. The document a shop hands
 * a fleet account at month-end.
 *
 * Guard: ADVISOR + OWNER + MASTER — matches /advisor/customers/[id].
 * Garage scope inside loadCustomerStatement() via Customer.garageId.
 * notFound() on miss so cross-garage existence never leaks via status.
 *
 * As-of date: `?asOf=YYYY-MM-DD`, defaults to today. Aging is
 * calculated against this date. Back-dating gives an accountant a
 * "balance as at end of last month" for a fleet client.
 *
 * Cost + margin: OFF by default on screen (toggle enables), ALWAYS
 * off on print. Same rule + same shared component as Batch A.
 */
export default async function CustomerStatementPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ asOf?: string; showCost?: string }>;
}) {
    const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
    const { id } = await params;
    const sp = await searchParams;
    const t = await getT();
    const locale = await getLocale();

    // Parse ?asOf=YYYY-MM-DD; fall back to today if absent/malformed.
    // Storing at 23:59:59 UTC of the given day so any invoice issued
    // ON asOf is included and any invoice due ON asOf reads as 0
    // days past due (bucket "current").
    let asOfDate: Date;
    if (sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf)) {
        asOfDate = new Date(`${sp.asOf}T23:59:59Z`);
    } else {
        asOfDate = new Date();
    }

    // Server-side cost gate — the numbers never enter the returned
    // shape (and therefore never enter the HTML) unless the URL says
    // so. AR 2026-08-25 verify: previous CSS-only hide left the
    // margin values in the payload for view-source.
    const showCost = sp.showCost === "1";

    const statement = await loadCustomerStatement(id, session.user.garageId, asOfDate, showCost);
    if (!statement) notFound();

    const country = statement.garage.country ?? "UAE";
    const tz = countryToTimeZone(country);

    // Human bucket label + on-screen colour class. Print sees only
    // the label text (colour classes are `print:text-black` etc.
    // where relevant). AR 2026-08-25: this doc goes to fleet clients
    // at month-end, so the aging labels must be legible in b&w.
    function bucketDisplay(bucket: string): { label: string; screenClass: string } {
        switch (bucket) {
            case "current":  return { label: t("statementBucketCurrent"),  screenClass: "text-text-mute" };
            case "d1_30":    return { label: t("statementBucket1_30"),    screenClass: "text-text" };
            case "d31_60":   return { label: t("statementBucket31_60"),   screenClass: "text-warning-700 dark:text-warning-500" };
            case "d61_90":   return { label: t("statementBucket61_90"),   screenClass: "text-warning-700 dark:text-warning-500 font-semibold" };
            case "d90_plus": return { label: t("statementBucket90_plus"), screenClass: "text-danger-700 dark:text-danger-500 font-semibold" };
            default:         return { label: bucket, screenClass: "" };
        }
    }

    const hasAdvances = statement.advances.length > 0;

    return (
        <main
            data-print-document="customer-statement"
            className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6"
        >
            <AppNav role="ADVISOR" active="customers" />

            <div className="flex flex-col gap-3 print:hidden sm:flex-row sm:items-center sm:justify-between">
                <Link
                    href={`/advisor/customers/${statement.customer.id}`}
                    className="inline-block py-2 text-sm text-text-mute hover:underline"
                >
                    ← {t("statementBackToCustomer")}
                </Link>
                <div className="flex items-center gap-2">
                    <CostVisibilityToggle
                        basePath={`/advisor/customers/${id}/statement`}
                        currentParams={sp}
                        showCost={showCost}
                    />
                    <PrintButton className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2">
                        🖨 {t("printLabel")}
                    </PrintButton>
                </div>
            </div>

            <DocumentHeader
                title={t("statementTitle")}
                jobCard={null}
                vehicle={null}
                garage={{
                    name: statement.garage.name,
                    trn: statement.garage.trn,
                    country,
                }}
                logoUrl={statement.garage.logoUrl ?? "/brand/garageos-logo.png"}
            />

            {/* Customer identity block + as-of date. */}
            <div className="rounded-xl border border-border bg-surface p-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                    <div>
                        <div className="text-xs uppercase tracking-wide text-text-mute">
                            {t("statementCustomerLabel")}
                        </div>
                        <div className="mt-0.5 text-lg font-semibold">{statement.customer.name}</div>
                        <div className="text-sm font-mono tabular-nums text-text-mute">
                            {statement.customer.phone}
                        </div>
                        {statement.customer.trn ? (
                            <div className="text-sm text-text-mute">
                                {t("statementCustomerTrnLabel")}:{" "}
                                <span className="font-mono tabular-nums">{statement.customer.trn}</span>
                            </div>
                        ) : null}
                    </div>
                    <div className="text-sm">
                        <div className="text-xs uppercase tracking-wide text-text-mute">
                            {t("statementAsOfLabel")}
                        </div>
                        <div className="mt-0.5 font-mono tabular-nums">
                            {fmtDate(statement.asOfDate, locale, tz)}
                        </div>
                    </div>
                </div>

                {/* Current vehicles owned — brief context. */}
                {statement.currentVehicles.length > 0 ? (
                    <div className="mt-3 border-t border-border pt-3 text-xs">
                        <div className="uppercase tracking-wide text-text-mute">
                            {t("statementVehiclesLabel")}
                        </div>
                        <ul className="mt-1 flex flex-col gap-0.5">
                            {statement.currentVehicles.map((v) => (
                                <li key={v.id}>
                                    <span className="font-mono tabular-nums">{v.plate}</span>{" "}
                                    · {v.make} {v.model}
                                    {v.year != null ? ` · ${v.year}` : ""}
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}
            </div>

            {/* ── Invoices table ── */}
            {statement.invoices.length === 0 ? (
                <p className="rounded-xl border border-border bg-surface-2 p-4 text-center text-sm text-text-mute">
                    {t("statementNoInvoices")}
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] border-collapse text-sm">
                        <thead className="bg-surface-2 text-xs uppercase tracking-wide text-text-mute">
                            <tr>
                                <th className="px-2 py-2 text-left">{t("statementColDate")}</th>
                                <th className="px-2 py-2 text-left">{t("statementColInvoice")}</th>
                                <th className="px-2 py-2 text-left">{t("statementColVehicle")}</th>
                                <th className="px-2 py-2 text-right">{t("statementColTotal")}</th>
                                <th className="px-2 py-2 text-right">{t("statementColPaid")}</th>
                                <th className="px-2 py-2 text-right">{t("statementColOutstanding")}</th>
                                <th className="px-2 py-2 text-left">{t("statementColDaysOverdue")}</th>
                                {/* Margin column: rendered only when
                                    the URL param is on. Off-state
                                    HTML never contains the margin
                                    number. AR 2026-08-25 verify. */}
                                {showCost ? (
                                    <>
                                        <th className="px-2 py-2 text-right" data-print-omit-cost>
                                            {t("statementColCost")}
                                        </th>
                                        <th className="px-2 py-2 text-right" data-print-omit-cost>
                                            {t("statementColMargin")}
                                        </th>
                                    </>
                                ) : null}
                            </tr>
                        </thead>
                        <tbody>
                            {statement.invoices.map((inv) => {
                                const bd = bucketDisplay(inv.bucket);
                                return (
                                    <tr
                                        key={inv.invoiceId}
                                        className={`border-t border-border align-top ${inv.fullyPaid ? "text-text-mute" : ""}`}
                                    >
                                        <td className="px-2 py-2 whitespace-nowrap tabular-nums">
                                            {fmtDate(inv.issuedAt, locale, tz)}
                                        </td>
                                        <td className="px-2 py-2 whitespace-nowrap font-mono tabular-nums">
                                            {formatInvoiceNo(inv.invoiceNumber, inv.issuedAt.getFullYear())}
                                        </td>
                                        <td className="px-2 py-2 text-xs">
                                            <div className="font-mono tabular-nums">{inv.vehiclePlate}</div>
                                            <div className="text-text-mute">{inv.vehicleMakeModel}</div>
                                        </td>
                                        <td className="px-2 py-2 text-right tabular-nums">{money(inv.total)}</td>
                                        <td className="px-2 py-2 text-right tabular-nums">{money(inv.paid)}</td>
                                        <td className="px-2 py-2 text-right tabular-nums font-semibold">
                                            {inv.fullyPaid ? (
                                                <span className="text-text-mute">—</span>
                                            ) : (
                                                money(inv.outstanding)
                                            )}
                                        </td>
                                        <td className="px-2 py-2 text-xs">
                                            {inv.fullyPaid ? (
                                                <span className="text-text-mute">—</span>
                                            ) : (
                                                <span className={bd.screenClass}>
                                                    {bd.label}
                                                    {inv.daysPastDue > 0 ? (
                                                        <span className="ml-1 font-mono tabular-nums">
                                                            ({inv.daysPastDue}d)
                                                        </span>
                                                    ) : null}
                                                </span>
                                            )}
                                        </td>
                                        {showCost ? (
                                            <>
                                                <td className="px-2 py-2 text-right tabular-nums" data-print-omit-cost>
                                                    {inv.cost != null ? money(inv.cost) : <span className="text-text-mute">—</span>}
                                                </td>
                                                <td className="px-2 py-2 text-right tabular-nums" data-print-omit-cost>
                                                    {inv.margin != null ? money(inv.margin) : <span className="text-text-mute">—</span>}
                                                </td>
                                            </>
                                        ) : null}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* ── Advance payments (credits) — only when any exist ── */}
            {hasAdvances ? (
                <div>
                    <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-mute">
                        {t("statementAdvancesHeading")}
                    </h2>
                    <table className="w-full border-collapse text-sm">
                        <thead className="bg-surface-2 text-xs uppercase tracking-wide text-text-mute">
                            <tr>
                                <th className="px-2 py-2 text-left">{t("statementColDate")}</th>
                                <th className="px-2 py-2 text-left">{t("statementColVehicle")}</th>
                                <th className="px-2 py-2 text-left">{t("statementAdvanceJobCol")}</th>
                                <th className="px-2 py-2 text-left">{t("statementAdvanceMethodCol")}</th>
                                <th className="px-2 py-2 text-right">{t("statementAdvanceAmountCol")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {statement.advances.map((a) => (
                                <tr key={a.advanceId} className="border-t border-border">
                                    <td className="px-2 py-2 whitespace-nowrap tabular-nums">
                                        {fmtDate(a.receivedAt, locale, tz)}
                                    </td>
                                    <td className="px-2 py-2 font-mono tabular-nums text-xs">{a.vehiclePlate}</td>
                                    <td className="px-2 py-2 font-mono tabular-nums text-xs">
                                        {a.jobNumber != null ? `JC-${a.jobNumber}` : "—"}
                                    </td>
                                    <td className="px-2 py-2 text-xs">{a.method}</td>
                                    <td className="px-2 py-2 text-right tabular-nums">
                                        {money(a.amount)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}

            {/* ── Aging summary + net balance ── */}
            <div className="rounded-xl border border-border bg-surface p-4">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-mute">
                    {t("statementAgingHeading")}
                </h2>
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                    <AgingCell label={t("statementBucketCurrent")}  amount={statement.aging.current} />
                    <AgingCell label={t("statementBucket1_30")}    amount={statement.aging.d1_30} />
                    <AgingCell label={t("statementBucket31_60")}   amount={statement.aging.d31_60} />
                    <AgingCell label={t("statementBucket61_90")}   amount={statement.aging.d61_90} />
                    <AgingCell label={t("statementBucket90_plus")} amount={statement.aging.d90_plus} />
                </div>
                <div className="mt-4 border-t border-border pt-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <span className="text-text-mute">{t("statementInvoicesOutstandingLabel")}</span>
                        <span className="tabular-nums">{money(statement.aging.invoicesOutstanding)}</span>
                    </div>
                    {hasAdvances ? (
                        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                            <span className="text-text-mute">
                                {t("statementAdvancesCreditLabel")}
                            </span>
                            <span className="tabular-nums">
                                −{money(statement.aging.advancesCredit)}
                            </span>
                        </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2 text-base font-semibold">
                        <span>{t("statementNetBalanceLabel")}</span>
                        <span className="tabular-nums">
                            {moneySigned(statement.aging.netBalance)}
                        </span>
                    </div>
                    {statement.aging.netBalance < 0 ? (
                        <div className="mt-1 text-xs text-text-mute">
                            {t("statementInCreditNote")}
                        </div>
                    ) : null}
                </div>
            </div>
        </main>
    );
}

function AgingCell({ label, amount }: { label: string; amount: number }) {
    return (
        <div className="rounded border border-border bg-surface-2 p-2">
            <div className="text-[10px] uppercase tracking-wide text-text-mute">{label}</div>
            <div className="mt-0.5 text-sm tabular-nums font-semibold">
                {amount === 0 ? "—" : `AED ${amount.toFixed(2)}`}
            </div>
        </div>
    );
}
