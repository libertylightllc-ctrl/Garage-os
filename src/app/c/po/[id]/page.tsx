import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/tokens";
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
    const id = verifyToken("po", token);
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
                            autoCreatedFromLine: {
                                select: {
                                    estimate: {
                                        select: {
                                            jobCard: {
                                                select: {
                                                    number: true,
                                                    vehicle: {
                                                        select: {
                                                            id: true,
                                                            make: true,
                                                            model: true,
                                                            year: true,
                                                            plate: true,
                                                            vin: true,
                                                            engineSize: true,
                                                            fuelType: true,
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            garage: {
                select: {
                    name: true,
                    trn: true,
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

    // Status-based classifier (2026-08-01, AR). Prices on the lines
    // do NOT flip the label — only the owner marking the PO ordered
    // does. See src/lib/po-doc-kind.ts.
    const isRfq = poDocKind({ status: po.status, orderedAt: po.orderedAt }) === "RFQ";
    const docTitle = isRfq ? t("documentRfq") : t("documentPurchaseOrder");
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
    const vehicles = resolvePoVehicles(po.lines);

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

            {/* Read-only lines table. RFQs render unit cost as "—"
                (asking the supplier to fill it in), POs render the
                agreed price. Total row lives below the table. */}
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[520px] text-sm">
                    <thead className="bg-surface-2 text-xs uppercase tracking-wide text-text-mute">
                        <tr>
                            <th className="px-3 py-2 text-left">{t("partName")}</th>
                            <th className="px-3 py-2 text-left">{t("colVehicle")}</th>
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
                                    <td className="px-3 py-2 text-xs">
                                        {lineVehicle ? (
                                            <div className="space-y-0.5">
                                                <div className="font-medium">
                                                    {formatVehicleShort(lineVehicle)}
                                                </div>
                                                {lineVehicle.vin ? (
                                                    <div className="font-mono text-[10px] text-muted-foreground">
                                                        VIN {lineVehicle.vin}
                                                    </div>
                                                ) : null}
                                                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                    JC-{lineVehicle.jobNumber}
                                                </div>
                                            </div>
                                        ) : (
                                            <span
                                                className="text-muted-foreground"
                                                title={t("noVehicleLinkedReason")}
                                            >
                                                {t("noVehicleLinkedShort")}
                                            </span>
                                        )}
                                    </td>
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
                                <td colSpan={4} className="px-3 py-2 text-right">
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
