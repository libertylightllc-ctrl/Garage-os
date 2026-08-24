"use client";

import { useState } from "react";

/**
 * Client-side toggle for cost + margin blocks on any printable
 * page that renders customer-facing on paper. Used on
 * /advisor/vehicles/[id]/history (Batch A) and
 * /advisor/customers/[id]/statement (Batch B). Off by default —
 * these documents end up in a customer's hand and the default
 * view must be safe to show.
 *
 * The toggle stamps a `<style>` tag with a state-driven rule that
 * hides every element carrying `data-cost-cell`. The @media print
 * clause below the state rule is the load-bearing bit — regardless
 * of the toggle's on/off state, print ALWAYS hides these cells.
 * Belt-and-braces: every element that carries `data-cost-cell` also
 * carries `data-print-omit-cost`, whose global rule in globals.css
 * already hides it on print (added AR 2026-08-14 for the profit
 * panel). Two independent rules; either alone is sufficient.
 *
 * Renamed from VehicleHistoryCostToggle 2026-08-25 (Batch B) — the
 * component is generic; the vehicle-history name was misleading
 * once the statement page reused it.
 */
export function CostVisibilityToggle() {
    const [show, setShow] = useState(false);
    return (
        <>
            <label className="print:hidden inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-text-mute">
                <input
                    type="checkbox"
                    checked={show}
                    onChange={(e) => setShow(e.target.checked)}
                    className="h-4 w-4 accent-brand-900 dark:accent-white"
                />
                Show cost + margin (screen only — never printed)
            </label>
            <style>{`
                [data-cost-cell] { display: ${show ? "" : "none"}; }
                @media print { [data-cost-cell] { display: none !important; } }
            `}</style>
        </>
    );
}
