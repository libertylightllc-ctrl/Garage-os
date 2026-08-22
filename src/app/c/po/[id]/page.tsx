import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { resolveDocumentToken } from "@/lib/document-tokens";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { DocumentHeader } from "@/components/document-header";
import { PrintButton } from "@/components/print-button";
import { resolvePoVehicles, formatVehicleShort } from "@/lib/po-vehicle";
import { poDocKind, isLineUnpriced } from "@/lib/po-doc-kind";

export const dynamic = "force-dynamic";

/**
 * Supplier-facing read-only view of a purchase order / RFQ.
 *
 * Reached via the signed link the shop owner sends (WhatsApp or
 * email). Token is scoped to `"po"` so a token minted for another
 * document kind cannot be replayed here — the signId/verifyToken
 * contract in src/lib/tokens.ts pins that.
 *
 * The page mirrors the on-owner-side print layout so what the
 * supplier sees matches what the owner printed: header block +
 * lines table + totals. Title switches between "Purchase Order"
 * and "Request for Quotation" per the same pricing-derived shape
 * used on the owner surface — an unpriced document going to a
 * supplier is an RFQ, and calling it a PO would be dishonest
 * labelling (AR's rule).
 *
 * Deliberately no interaction: no accept/reject buttons, no line
 * pricing form. The supplier's channel back is WhatsApp / email
 * reply, not this page. If we add supplier-side line pricing
 * later, that's a separate route with its own auth.
 */
export default async function PublicPurchaseOrder({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id: token } = await params;
    const id = await resolveDocumentToken("po", token);
    if (!id) notFound();

    const po = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: {
            supplier: {
                select: { name: true, contactPerson: true, phone: true, email: true },
            },
            lines: {
                orderBy: { createdAt: "asc" },
                include: {
                    part: {
                        select: {
                            name: true,
                            sku: true,
                            // No `autoCreatedFromLine` — removed
                            // 2026-08-02 with the resolver's chain
                            // fallback. See resolvePoVehicles.
                        },
                    },
                },
            },
            garage: {
                select: {
                    name: true,
                    trn: true,
                    address: true,
                    country: true,
                    logoUrl: true,
                },
            },
        },
    });
    if (!po) notFound();

    const t = await getT();
    const locale = await getLocale();
    const tz = countryToTimeZone(po.garage.country ?? "UAE");

    // Status + intent classifier (2026-08-02). DRAFT with intent=ORDER
    // reads as "Purchase Order (draft)" so the supplier receiving the
    // link sees the doc labelled as its author intended, not
    // misclassified as an RFQ. Committed rows still read as
    // "Purchase order" — Mark Ordered is what turns quotation into
    // order. See src/lib/po-doc-kind.ts.
    const docKind = poDocKind({
        status: po.status,
        orderedAt: po.orderedAt,
        intent: po.intent,
    });
    const isRfq = docKind === "RFQ";
    const docTitle =
        docKind === "RFQ"
            ? t("documentRfq")
            : docKind === "PO_DRAFT"
            ? t("documentPurchaseOrderDraft")
            : t("documentPurchaseOrder");
    const docNumber = po.reference?.trim()
        ? po.reference
        : `#${po.id.slice(-6).toUpperCase()}`;

    const money = (v: number) =>
        new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(v);
    // A PO (kind === "PO") is guaranteed all-lines-priced by
    // canMarkOrdered at DRAFT→ORDERED, and post-order lines are read-
    // only, so this reduce never sums a null unitCost when the total
    // row is actually rendered. The RFQ branch below suppresses the
    // tfoot entirely — no supplier ever sees a partial-sum total.
    const total = po.lines.reduce((s, l) => s + l.qty * Number(l.unitCost ?? 0), 0);
    // Fix #3 followup (2026-08-02): doc-level default falls back for
    // any line without its own snapshot. That includes rows created
    // before defaults existed and any line whose write-time copy
    // silently landed as null (the old resolver's strict predicate
    // was hiding those).
    const vehicles = resolvePoVehicles(po.lines, {
        defaultVehicleId: po.defaultVehicleId,
        defaultVehicleMake: po.defaultVehicleMake,
        defaultVehicleModel: po.defaultVehicleModel,
        defaultVehicleYear: po.defaultVehicleYear,
        defaultVehiclePlate: po.defaultVehiclePlate,
        defaultVehicleVin: po.defaultVehicleVin,
        defaultVehicleEngineSize: po.defaultVehicleEngineSize,
        defaultVehicleFuelType: po.defaultVehicleFuelType,
        defaultVehicleJobNumber: po.defaultVehicleJobNumber,
    });
    // AR 2026-08-23 — same shape as the internal PO page. Full
    // vehicle details render ONCE above the table:
    //   singleVehicle    → one-line caption
    //   multi-vehicle    → one row per distinct car in a compact block
    // Per-row Vehicle cell drops to plate + JC# alone (or make/model
    // when no plate). Was 7 lines per row, which overflowed A4 and
    // cut UNIT COST + LINE TOTAL off the printed page.
    const singleVehicle =
        vehicles.allResolved && vehicles.distinct.length === 1
            ? vehicles.distinct[0]
            : null;

    return (
        <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-5 p-6">
            {/* Print button — supplier can save-as-PDF via their
                browser's print dialog. Off-print via `print:hidden`
                inside the button's own class. */}
            <div className="print:hidden">
                <PrintButton className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-semibold hover:bg-surface-2">
                    🖨 {t("printPo")}
                </PrintButton>
            </div>

            {/* Customer-facing header — pass raw logoUrl. When null,
                header falls back to text-only garage name. We do NOT
                add the GarageOS mark on a supplier's document. */}
            <DocumentHeader
                title={docTitle}
                supplier={{
                    name: po.supplier.name,
                    reference: po.reference,
                    refLabel: t("supplierRef"),
                }}
                garage={po.garage}
                logoUrl={po.garage.logoUrl}
            />

            {/* Vehicle context up top so per-row cells stay short.
                AR 2026-08-23 — was rendering seven-line vehicle stacks
                per row on multi-vehicle POs, blowing the table past
                A4 and cutting UNIT COST + LINE TOTAL off page 1. */}
            {singleVehicle ? (
                <section className="rounded-lg border border-border/60 bg-surface-2/40 px-3 py-2 text-xs">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-text-mute">
                        {t("colVehicle")}
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        {singleVehicle.make || singleVehicle.model ? (
                            <span className="font-medium">
                                {[
                                    singleVehicle.make,
                                    singleVehicle.model,
                                    singleVehicle.year != null
                                        ? String(singleVehicle.year)
                                        : null,
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                            </span>
                        ) : null}
                        {singleVehicle.engineSize || singleVehicle.fuelType ? (
                            <span className="text-text-mute">
                                {[singleVehicle.engineSize, singleVehicle.fuelType]
                                    .filter(Boolean)
                                    .join(" ")}
                            </span>
                        ) : null}
                        {singleVehicle.plate ? (
                            <span className="font-medium">{singleVehicle.plate}</span>
                        ) : null}
                        {singleVehicle.vin ? (
                            <span className="font-mono text-text-mute">
                                VIN {singleVehicle.vin}
                            </span>
                        ) : null}
                        {singleVehicle.jobNumber != null ? (
                            <span className="text-text-mute">
                                JC-{singleVehicle.jobNumber}
                            </span>
                        ) : null}
                    </div>
                </section>
            ) : vehicles.distinct.length > 1 ? (
                <section className="rounded-lg border border-border/60 bg-surface-2/40 px-3 py-2 text-xs">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-text-mute">
                        {t("colVehicles")}
                    </div>
                    <ul className="mt-1 flex flex-col gap-1">
                        {vehicles.distinct.map((v, i) => (
                            <li
                                key={`${v.plate ?? ""}-${v.jobNumber ?? ""}-${i}`}
                                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
                            >
                                {v.plate ? (
                                    <span className="font-medium">{v.plate}</span>
                                ) : null}
                                {v.jobNumber != null ? (
                                    <span className="text-text-mute">
                                        JC-{v.jobNumber}
                                    </span>
                                ) : null}
                                {v.make || v.model ? (
                                    <span>
                                        {[
                                            v.make,
                                            v.model,
                                            v.year != null ? String(v.year) : null,
                                        ]
                                            .filter(Boolean)
                                            .join(" ")}
                                    </span>
                                ) : null}
                                {v.engineSize || v.fuelType ? (
                                    <span className="text-text-mute">
                                        {[v.engineSize, v.fuelType]
                                            .filter(Boolean)
                                            .join(" ")}
                                    </span>
                                ) : null}
                                {v.vin ? (
                                    <span className="font-mono text-text-mute">
                                        VIN {v.vin}
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {/* Read-only lines table. RFQs render unit cost as "—"
                (asking the supplier to fill it in), POs render the
                agreed price. Total row lives below the table. */}
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[520px] text-sm">
                    <thead className="bg-surface-2 text-xs uppercase tracking-wide text-text-mute">
                        <tr>
                            <th className="px-3 py-2 text-left">{t("partName")}</th>
                            {/* Vehicle column shows only when this PO has
                                MORE THAN ONE distinct car — the block above
                                already carries the vehicle context for the
                                single-vehicle case, and dropping the column
                                keeps the table narrow enough to fit A4 without
                                truncating UNIT COST / LINE TOTAL. Old rule
                                (anyResolved) rendered the column even for
                                single-vehicle POs; new rule (distinct > 1)
                                matches the internal PO page. AR 2026-08-23. */}
                            {vehicles.distinct.length > 1 ? (
                                <th className="px-3 py-2 text-left">{t("colVehicle")}</th>
                            ) : null}
                            <th className="px-3 py-2 text-right">{t("poOrdered")}</th>
                            <th className="px-3 py-2 text-right">{t("poUnitCost")}</th>
                            <th className="px-3 py-2 text-right">{t("poLineTotal")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {po.lines.map((l) => {
                            const unit = Number(l.unitCost);
                            const lineVehicle = vehicles.perLine.get(l.id) ?? null;
                            return (
                                <tr key={l.id} className="border-t border-border align-top">
                                    <td className="px-3 py-2 font-medium">
                                        {/* Layer 0 free-text RFQ line: no catalog
                                            Part yet, so fall back to the row's
                                            own description + sku. Once the shop
                                            links it (Layer 5), l.part fills in
                                            and takes precedence. */}
                                        {l.part?.name ?? l.description}{" "}
                                        <span className="font-mono text-xs text-muted-foreground">
                                            {l.part?.sku ?? l.sku ?? ""}
                                        </span>
                                    </td>
                                    {vehicles.distinct.length > 1 ? (
                                        <td className="px-3 py-2 text-xs">
                                            {lineVehicle ? (
                                                // AR 2026-08-23 — condensed to
                                                // plate + JC# (or make/model when
                                                // no plate). Full details for
                                                // every distinct vehicle live in
                                                // the "Vehicles on this order"
                                                // block above the table; the row
                                                // only needs to say WHICH car it
                                                // belongs to.
                                                <div className="flex flex-col gap-0.5">
                                                    {lineVehicle.plate ? (
                                                        <span className="font-medium">
                                                            {lineVehicle.plate}
                                                        </span>
                                                    ) : lineVehicle.make || lineVehicle.model ? (
                                                        <span className="font-medium">
                                                            {[lineVehicle.make, lineVehicle.model]
                                                                .filter(Boolean)
                                                                .join(" ")}
                                                        </span>
                                                    ) : null}
                                                    {lineVehicle.jobNumber != null ? (
                                                        <span className="text-[10px] uppercase tracking-wide text-text-mute">
                                                            JC-{lineVehicle.jobNumber}
                                                        </span>
                                                    ) : null}
                                                </div>
                                            ) : (
                                                <span aria-hidden="true">&nbsp;</span>
                                            )}
                                        </td>
                                    ) : null}
                                    <td className="px-3 py-2 text-right tabular-nums">{l.qty}</td>
                                    {/* Per-LINE decision, not per-document: a
                                        mixed RFQ shows real prices on priced
                                        lines and a "please quote" marker only
                                        on the ones the supplier needs to fill
                                        in. */}
                                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                        {isLineUnpriced(l) ? (
                                            <span className="inline-flex items-center gap-1.5">
                                                <span>—</span>
                                                {/* Marker element — NOT part of the
                                                    description or any stored field. */}
                                                <span className="rounded-md border border-warning-500/40 bg-warning-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                                                    {t("lineUnpricedTag")}
                                                </span>
                                            </span>
                                        ) : (
                                            money(unit)
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {isLineUnpriced(l) ? "—" : money(l.qty * unit)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                    {isRfq ? null : (
                        <tfoot className="border-t border-border bg-surface-2/50 text-sm font-medium">
                            <tr>
                                <td
                                    colSpan={vehicles.anyResolved ? 4 : 3}
                                    className="px-3 py-2 text-right"
                                >
                                    {t("printTotalsLabel")}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {money(total)}
                                </td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>

            {po.note ? (
                <p className="whitespace-pre-line rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                    {po.note}
                </p>
            ) : null}

            <p className="text-xs text-muted-foreground">
                {t("printedOn")}: {fmtDate(new Date(), locale, tz)}
            </p>
        </main>
    );
}
