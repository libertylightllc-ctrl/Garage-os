"use client";

import { useState } from "react";

/**
 * Client-side toggle for the cost + margin columns/blocks on
 * /advisor/vehicles/[id]/history. Off by default (this document
 * ends up in a customer's hand more often than any other; the
 * default view must be safe to show).
 *
 * The toggle stamps a `<style>` tag with a state-driven rule that
 * hides every element carrying `data-cost-cell`. The @media print
 * clause below the state rule is the load-bearing bit — regardless
 * of the toggle's on/off state, print ALWAYS hides these cells.
 * Belt-and-braces: every element that carries `data-cost-cell` also
 * carries `data-print-omit-cost`, whose global rule in globals.css
 * already hides it on print (added AR 2026-08-14 for the profit
 * panel). Two independent rules; either alone is sufficient.
 */
export function VehicleHistoryCostToggle() {
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
