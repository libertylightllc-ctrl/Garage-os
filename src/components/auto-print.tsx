"use client";

import { useEffect } from "react";

// Fires the print dialog once on mount. Used by the dedicated receipt
// route so the cashier opens /invoices/[id]/receipt in a new tab,
// the print dialog comes up immediately, and they tap Print (or
// 'Save as PDF' on mobile) without an intermediate click.

export function AutoPrint() {
    useEffect(() => {
        // Defer by one tick so the page paints first — printing a
        // half-rendered page on Safari occasionally cuts the bottom off.
        const id = window.setTimeout(() => window.print(), 50);
        return () => window.clearTimeout(id);
    }, []);
    return null;
}
