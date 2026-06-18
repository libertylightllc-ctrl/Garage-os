"use client";

import { useEffect, useId, useRef, useState } from "react";

// Real-time filter bar for the cashier dashboard + paid-invoices page.
//
// Architecture: rows on the page are rendered server-side as usual.
// Each filterable row is tagged with:
//   data-filter-row              (marker — present means 'I can be hidden')
//   data-search="<tokens>"       (lowercase, space-joined searchable text:
//                                 invoice no., job no., plate, customer
//                                 name, vehicle make/model — anything the
//                                 cashier might type to find this row)
//   data-date="YYYY-MM-DD"       (the row's representative date: invoice
//                                 issuedAt, or job createdAt for un-
//                                 invoiced jobs)
//
// Section wrappers are tagged data-filter-section so we can fully hide
// a section header + body when every row inside has been filtered out
// (avoids dangling 'Receivables (unpaid)' headers with no contents).
//
// All filtering happens entirely in the DOM via useEffect — no React
// state per row, no re-render of the rest of the page. Suitable for
// the current data volumes (<100 rows). If a garage scales past that,
// switch to server-side filtering via searchParams.

export interface CashierFilterBarLabels {
    searchPlaceholder: string;
    fromLabel: string;
    toLabel: string;
    clearLabel: string;
}

export function CashierFilterBar({ labels }: { labels: CashierFilterBarLabels }) {
    const [search, setSearch] = useState("");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const searchInputId = useId();
    const fromInputId = useId();
    const toInputId = useId();
    // Ref to the form so 'Clear' can reset all three inputs at once.
    const formRef = useRef<HTMLFormElement>(null);

    // Re-apply filtering whenever any of the three inputs change. The
    // dependency list is exhaustive — adding a new filter type later
    // would just need adding the state + bumping the deps.
    useEffect(() => {
        const q = search.trim().toLowerCase();
        const fromIso = from || null;
        const toIso = to || null;

        // Hide non-matching rows.
        const rows = document.querySelectorAll<HTMLElement>("[data-filter-row]");
        rows.forEach((el) => {
            const tokens = (el.getAttribute("data-search") ?? "").toLowerCase();
            const date = el.getAttribute("data-date") ?? "";
            const matchQuery = !q || tokens.includes(q);
            const matchFrom = !fromIso || (date && date >= fromIso);
            const matchTo = !toIso || (date && date <= toIso);
            el.style.display = matchQuery && matchFrom && matchTo ? "" : "none";
        });

        // Collapse sections whose rows are now all hidden. Sections with
        // ZERO filterable rows in the first place (e.g. the metrics grid)
        // are left visible by virtue of having no data-filter-row children.
        const sections =
            document.querySelectorAll<HTMLElement>("[data-filter-section]");
        sections.forEach((section) => {
            const rowsInside =
                section.querySelectorAll<HTMLElement>("[data-filter-row]");
            if (rowsInside.length === 0) return; // not a row container
            const anyVisible = Array.from(rowsInside).some(
                (r) => r.style.display !== "none",
            );
            section.style.display = anyVisible ? "" : "none";
        });
    }, [search, from, to]);

    const handleClear = () => {
        setSearch("");
        setFrom("");
        setTo("");
        formRef.current?.reset();
    };

    return (
        <form
            ref={formRef}
            // The form swallows Enter so a casual press doesn't trigger
            // any inadvertent navigation. Filtering is already live.
            onSubmit={(e) => e.preventDefault()}
            className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-4"
        >
            <div className="flex flex-1 flex-col gap-1">
                <label
                    htmlFor={searchInputId}
                    className="text-xs text-text-mute"
                >
                    {labels.searchPlaceholder}
                </label>
                <input
                    id={searchInputId}
                    type="text"
                    inputMode="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="INV-2026-0013, A 12345, Ahmed Al Mansoori, #38…"
                    className="h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                />
            </div>
            <div className="flex flex-col gap-1">
                <label
                    htmlFor={fromInputId}
                    className="text-xs text-text-mute"
                >
                    {labels.fromLabel}
                </label>
                <input
                    id={fromInputId}
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                />
            </div>
            <div className="flex flex-col gap-1">
                <label
                    htmlFor={toInputId}
                    className="text-xs text-text-mute"
                >
                    {labels.toLabel}
                </label>
                <input
                    id={toInputId}
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className="h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                />
            </div>
            <button
                type="button"
                onClick={handleClear}
                disabled={!search && !from && !to}
                // 'Clear' stays visible at all times so the cashier always
                // sees a way to reset (vs hiding when no filter is active).
                // Just disable it then so the affordance is clear.
                className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            >
                ✕ {labels.clearLabel}
            </button>
        </form>
    );
}
