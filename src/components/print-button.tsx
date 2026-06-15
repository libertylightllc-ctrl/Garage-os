"use client";

import type { ReactNode } from "react";

// Small client wrapper that fires window.print() on click. We can't
// call window.print() from a server component, but we don't need any
// other client state — so this thin button is the entire surface
// area. Used by the invoice and receipt pages to expose the browser's
// native print dialog. On mobile the dialog includes 'Save as PDF',
// which the spec calls out explicitly.

export function PrintButton({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <button
            type="button"
            onClick={() => window.print()}
            className={className}
        >
            {children}
        </button>
    );
}
