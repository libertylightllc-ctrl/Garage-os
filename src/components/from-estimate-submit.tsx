"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * The from-estimate conversion screen's submit control + approx-total.
 *
 * Uniquely among the five PO/RFQ surfaces, this one reads a form
 * IN PROGRESS: the advisor may edit prefilled costs before clicking.
 * A server-rendered label computed from prefills gets stale the
 * moment the advisor touches a cost input. This component subscribes
 * to the form's live cost inputs and re-classifies each render — so
 * the button reads "Create draft PO" the instant every cost goes
 * positive, and "Create request for quotation" if even one line
 * still reads 0 (or blank / negative / non-numeric).
 *
 * The classifier itself is not duplicated: the rule (any unpriced
 * line → RFQ, empty → RFQ) is the same as `poDocKind` in
 * @/lib/po-doc-kind, applied to the currently-typed values. The
 * empty-total suppression matches the other four surfaces' rule.
 *
 * Both the button and the approx-total live inside the same form,
 * so this component is placed inside the form JSX. It listens to
 * "input" events on the form's `input[name^="cost_"]` boxes.
 *
 * Initial render is server-side: `document` is not defined, so the
 * classifier defaults to RFQ (the empty-doc default). Once the
 * client hydrates and the effect runs, the state jumps to the true
 * live values.
 */
export function FromEstimateSubmit(props: {
    disabled: boolean;
    /** "Approx. total" label — parent passes t("approxTotal") value. */
    approxTotalLabel: string;
    /** BCP-47 locale for the currency formatter (e.g. "en-AE" / "ar-AE"). */
    locale: string;
    /** ISO 4217 currency code (AED for the UAE-only Phase 1). */
    currency: string;
    /** Button labels — parent passes both, we swap live. */
    labelPo: string;
    labelRfq: string;
}) {
    const formatMoney = useMemo(
        () =>
            new Intl.NumberFormat(props.locale, {
                style: "currency",
                currency: props.currency,
            }),
        [props.locale, props.currency],
    );

    // Doc kind + total live in state — recomputed by the effect on
    // every keystroke, never during render. Initial (SSR + first
    // client render) defaults to RFQ / 0 so we don't touch `document`
    // where it isn't defined; the effect runs after mount and updates
    // to the true live values.
    const [state, setState] = useState<{ isRfq: boolean; total: number }>({
        isRfq: true,
        total: 0,
    });

    useEffect(() => {
        const btn = document.getElementById("from-estimate-submit-btn");
        const form = btn?.closest("form");
        if (!form) return;
        const reclassify = () => {
            const costEls = Array.from(
                form.querySelectorAll<HTMLInputElement>('input[name^="cost_"]'),
            );
            if (costEls.length === 0) {
                setState({ isRfq: true, total: 0 });
                return;
            }
            let allPriced = true;
            let sum = 0;
            for (const el of costEls) {
                const suffix = el.name.slice("cost_".length);
                const qtyEl = form.querySelector<HTMLInputElement>(
                    `input[name="qty_${suffix}"]`,
                );
                const cost = Number(el.value);
                const qty = qtyEl ? Number(qtyEl.value) : 1;
                // `Number.isFinite(n) && n > 0` matches `isLinePriced`
                // in @/lib/po-doc-kind: NaN, negative, blank → unpriced
                // → RFQ. Empty form (no cost inputs) → RFQ, same as
                // `poDocKind`'s empty-default rule.
                if (!(Number.isFinite(cost) && cost > 0)) allPriced = false;
                if (Number.isFinite(cost) && Number.isFinite(qty)) sum += cost * qty;
            }
            setState({ isRfq: !allPriced, total: sum });
        };
        reclassify();
        form.addEventListener("input", reclassify);
        return () => {
            form.removeEventListener("input", reclassify);
        };
    }, []);

    return (
        <>
            <div className="pt-1">
                <Button
                    id="from-estimate-submit-btn"
                    type="submit"
                    variant="hero"
                    disabled={props.disabled}
                >
                    {state.isRfq ? props.labelRfq : props.labelPo}
                </Button>
            </div>

            {/* Approx-total: suppressed on RFQ because the number is
                either 0.00 (all zero, meaningless) or a partial sum
                that misrepresents cost (mixed — priced lines only,
                doesn't count the unpriced ones the supplier will
                quote). Both cases fail toward showing nothing. On PO,
                the total is computed from the LIVE inputs so it
                matches what the server action will record. */}
            {state.isRfq ? null : (
                <p className="pt-1 text-xs text-muted-foreground">
                    {props.approxTotalLabel}: {formatMoney.format(state.total)}
                </p>
            )}
        </>
    );
}
