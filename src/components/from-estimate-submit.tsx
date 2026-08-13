"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * The from-estimate conversion screen's submit controls + approx-total.
 *
 * Two-button UX (AR 2026-08-14). Matches /owner/purchasing's index,
 * where "New quotation" and "New purchase order" are separate buttons
 * that steer /owner/purchasing/new via ?mode=. Here they're two
 * submits on the same form, differentiated by name="intent":
 *
 *   Quotation  — always enabled. Owner is asking the supplier what it
 *                costs; blanks are legitimate. Server accepts blank
 *                unitCost on any included line.
 *   Purchase   — disabled while any INCLUDED line has no cost. Reason
 *   Order        rendered below the button (not just in the disabled
 *                tooltip) so a touch-first user sees exactly why they
 *                can't tap it. Server also rejects intent=po with any
 *                blank cost as belt-and-braces against a client bypass.
 *
 * The include-checkbox state is watched too — unchecking a blank-cost
 * line re-enables the PO button, because that line no longer counts.
 *
 * Initial (SSR) state is passed in as `unpricedIncludedInitial` /
 * `approxTotalInitial` so the buttons render correctly before hydration
 * — otherwise the PO button flickers enabled → disabled on load.
 * After hydration, the effect subscribes to form input + change events
 * and recomputes on every keystroke / tick.
 *
 * The `id="from-estimate-form"` attribute on the parent form is what
 * this component's effect keys off — if the page renames or drops
 * that id, this component's cost-live-view stops working (buttons
 * stay in their SSR-computed state).
 */
export function FromEstimateSubmit(props: {
    /** Overall disable (e.g., no suppliers configured). Beats intent-specific gates. */
    disabled: boolean;
    /** "Create quotation" — parent passes t("createQuotation"). */
    labelRfq: string;
    /** "Create purchase order" — parent passes t("createPurchaseOrder"). */
    labelPo: string;
    /** "Approx. total" — parent passes t("approxTotal"). */
    approxTotalLabel: string;
    /**
     * Template for the visible reason under the PO button when any
     * included line has no cost. Must contain the literal "{n}", which
     * this component substitutes with the count.
     */
    poDisabledReasonTemplate: string;
    /** SSR-time count of included lines with no prefilled cost. */
    unpricedIncludedInitial: number;
    /** SSR-time sum of qty × cost across priced included lines. */
    approxTotalInitial: number;
    /** BCP-47 locale for the currency formatter (e.g. "en-AE"). */
    locale: string;
    /** ISO 4217 currency code (AED for the UAE-only Phase 1). */
    currency: string;
}) {
    const formatMoney = useMemo(
        () =>
            new Intl.NumberFormat(props.locale, {
                style: "currency",
                currency: props.currency,
            }),
        [props.locale, props.currency],
    );

    const [state, setState] = useState<{
        unpricedIncluded: number;
        total: number;
    }>({
        unpricedIncluded: props.unpricedIncludedInitial,
        total: props.approxTotalInitial,
    });

    useEffect(() => {
        const form = document.getElementById(
            "from-estimate-form",
        ) as HTMLFormElement | null;
        if (!form) return;
        const reclassify = () => {
            const costEls = Array.from(
                form.querySelectorAll<HTMLInputElement>('input[name^="cost_"]'),
            );
            let unpriced = 0;
            let sum = 0;
            for (const el of costEls) {
                const suffix = el.name.slice("cost_".length);
                // Skip lines the owner unchecked — the server also
                // filters against `include`, so an unchecked line
                // shouldn't gate the PO button.
                const includeEl = form.querySelector<HTMLInputElement>(
                    `input[name="include"][value="${suffix}"]`,
                );
                if (includeEl && !includeEl.checked) continue;
                const qtyEl = form.querySelector<HTMLInputElement>(
                    `input[name="qty_${suffix}"]`,
                );
                const cost = Number(el.value);
                const qty = qtyEl ? Number(qtyEl.value) : 1;
                // `Number.isFinite(n) && n > 0` matches the isLinePriced
                // rule in @/lib/po-doc-kind: NaN, negative, blank → unpriced.
                if (!(Number.isFinite(cost) && cost > 0)) {
                    unpriced++;
                } else if (Number.isFinite(qty)) {
                    sum += cost * qty;
                }
            }
            setState({ unpricedIncluded: unpriced, total: sum });
        };
        reclassify();
        form.addEventListener("input", reclassify);
        // Include-checkbox tick is a `change` event, not `input` — a
        // blank line unchecked should immediately enable the PO button.
        form.addEventListener("change", reclassify);
        return () => {
            form.removeEventListener("input", reclassify);
            form.removeEventListener("change", reclassify);
        };
    }, []);

    const poBlockedByUnpriced = state.unpricedIncluded > 0;
    const poDisabled = props.disabled || poBlockedByUnpriced;
    const poReason = poBlockedByUnpriced
        ? props.poDisabledReasonTemplate.replace(
              "{n}",
              String(state.unpricedIncluded),
          )
        : "";

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
                {/* Quotation — always available. Owner is asking the
                    supplier what the parts cost; blanks are the intent. */}
                <Button
                    type="submit"
                    name="intent"
                    value="rfq"
                    variant="ghost"
                    disabled={props.disabled}
                >
                    {props.labelRfq}
                </Button>
                {/* Purchase order — disabled while any included line
                    lacks a cost. Reason rendered below, not just via
                    title="", so touch users see it too. */}
                <Button
                    type="submit"
                    name="intent"
                    value="po"
                    variant="hero"
                    disabled={poDisabled}
                    title={poReason || undefined}
                >
                    {props.labelPo}
                </Button>
            </div>
            {poBlockedByUnpriced ? (
                <p className="text-xs text-warning-600 dark:text-warning-500">
                    ⚠ {poReason}
                </p>
            ) : null}
            {/* Approx-total only when PO is submittable AND non-zero.
                Suppressed on the RFQ path because the sum is either
                zero (nothing to show) or a partial sum that
                misrepresents the true cost (priced-only, doesn't count
                unpriced lines the supplier will quote). */}
            {!poDisabled && state.total > 0 ? (
                <p className="text-xs text-muted-foreground">
                    {props.approxTotalLabel}: {formatMoney.format(state.total)}
                </p>
            ) : null}
        </div>
    );
}
