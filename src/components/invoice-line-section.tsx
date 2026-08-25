/**
 * One section of the three-section invoice line table (AR 2026-08-25
 * Batch D). Same shape as the estimate preview's SectionTable, but
 * with the two extra invoice-only columns (VAT + line-total = amount
 * + VAT) that a UAE tax invoice must show.
 *
 * Shared by the staff-facing invoice preview and the customer-facing
 * invoice so the two documents never diverge. The wrapper decides
 * layout / border / dark-mode; this component is body-only.
 *
 * Renders nothing when `lines` is empty — callers gate on
 * `section.lines.length > 0` before mounting.
 */

import type { MessageKey } from "@/i18n/config";
import { translateLineDescription } from "@/lib/line-item-translations";

export interface InvoiceLineRow {
    id: string;
    description: string;
    qty: number;
    unitPrice: number;
    lineTotal: number;
}

interface Props {
    title: string;
    lines: InvoiceLineRow[];
    subtotal: number;
    locale: string;
    t: (k: MessageKey) => string;
    /** VAT rate as a decimal, e.g. 0.05 for UAE 5%. */
    vatRate: number;
    /** Optional row-level classNames so the caller can theme the
     *  section (staff preview = zinc palette on white; customer
     *  page = themed surface). Sensible defaults included. */
    borderClass?: string;
    subtleTextClass?: string;
    subtotalRowClass?: string;
    headingClass?: string;
}

export function InvoiceLineSection({
    title,
    lines,
    subtotal,
    locale,
    t,
    vatRate,
    borderClass = "border-b border-black/5",
    subtleTextClass = "text-zinc-500",
    subtotalRowClass = "border-t border-black/10",
    headingClass = "text-zinc-600",
}: Props) {
    if (lines.length === 0) return null;
    return (
        <div>
            <h3 className={`mb-1 text-xs font-semibold uppercase tracking-wide ${headingClass}`}>
                {title}
            </h3>
            <table className="w-full text-sm tabular-nums">
                <thead>
                    <tr className={`border-b border-black/10 ${subtleTextClass}`}>
                        <th className="py-1 pe-2 text-start font-medium">{t("colDescription")}</th>
                        <th className="py-1 text-end font-medium">{t("colQty")}</th>
                        <th className="py-1 text-end font-medium">{t("colUnit")}</th>
                        <th className="py-1 text-end font-medium">{t("colAmount")}</th>
                        <th className="py-1 text-end font-medium">{t("colVat")}</th>
                        <th className="py-1 text-end font-medium">{t("colLineTotal")}</th>
                    </tr>
                </thead>
                <tbody>
                    {lines.map((l) => {
                        const amt = l.lineTotal;
                        const vat = amt * vatRate;
                        return (
                            <tr key={l.id} className={borderClass}>
                                <td className="py-1 pe-2">
                                    {translateLineDescription(l.description, locale)}
                                </td>
                                <td className="py-1 text-end">{l.qty.toLocaleString(locale)}</td>
                                <td className="py-1 text-end">{l.unitPrice.toFixed(2)}</td>
                                <td className="py-1 text-end">{amt.toFixed(2)}</td>
                                <td className="py-1 text-end">{vat.toFixed(2)}</td>
                                <td className="py-1 text-end font-medium">
                                    {(amt + vat).toFixed(2)}
                                </td>
                            </tr>
                        );
                    })}
                    <tr className={subtotalRowClass}>
                        <td
                            colSpan={5}
                            className={`py-1 text-end text-xs font-semibold ${headingClass}`}
                        >
                            {t("estimateSectionSubtotal")}
                        </td>
                        <td className="py-1 text-end font-semibold">{subtotal.toFixed(2)}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}
