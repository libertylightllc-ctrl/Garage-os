"use client";

// URL-driven paginator. Every state change edits ?page= or ?per= and lets
// Next.js re-render server-side — no client-side data caching, no drift
// between page control state and actually-visible rows.
//
// Filter-aware count: the cashier FilterBar filters client-side (DOM
// display:none on data-filter-row), so on the server the counter is the
// UNFILTERED total. Showing "1-20 of 247" while the user is filtering
// would be a lie. So this component watches for changes to the filter
// inputs and hides the count line whenever any of q/from/to is non-empty.

import Link from "next/link";
import { useEffect, useState } from "react";

export interface PaginatorLabels {
  /** "Showing {from}-{to} of {total}" */
  showing: string;
  /** "Rows per page" */
  rowsPerPage: string;
  /** "Prev" */
  prev: string;
  /** "Next" */
  next: string;
}

export function Paginator({
  currentPath,
  currentSearchParams,
  page,
  perPage,
  pageCount,
  from,
  to,
  total,
  labels,
  perPageOptions,
}: {
  /** e.g. "/cashier" — the pathname to link back to */
  currentPath: string;
  /** URL-encoded string of the current query, without leading "?".
   *  We rebuild only the page + per keys, preserving everything else
   *  (tab, filter). */
  currentSearchParams: string;
  page: number;
  perPage: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  labels: PaginatorLabels;
  perPageOptions: readonly number[];
}) {
  // Detect an active client-side filter. The FilterBar renders three
  // inputs by placeholder; there is no shared ref registry across
  // components, so we probe the DOM for them by their input types. Not
  // pretty, but scoped: a change event on any of the three flips
  // `filterActive` immediately, and page reload resets it correctly
  // (SSR always renders with filterActive=false).
  const [filterActive, setFilterActive] = useState(false);
  useEffect(() => {
    const form = document.querySelector<HTMLFormElement>(
      "form input[type=text][inputmode=search]",
    )?.closest("form");
    if (!form) return;
    const inputs = Array.from(
      form.querySelectorAll<HTMLInputElement>("input[type=text], input[type=date]"),
    );
    const check = () => setFilterActive(inputs.some((i) => i.value.trim() !== ""));
    check();
    inputs.forEach((i) => i.addEventListener("input", check));
    return () => inputs.forEach((i) => i.removeEventListener("input", check));
  }, []);

  function hrefWith(overrides: { page?: number; per?: number }): string {
    const params = new URLSearchParams(currentSearchParams);
    if (overrides.per !== undefined) {
      params.set("per", String(overrides.per));
      // Changing rows-per-page always resets to page 1 (spec).
      params.set("page", "1");
    }
    if (overrides.page !== undefined) {
      params.set("page", String(overrides.page));
    }
    const qs = params.toString();
    return qs ? `${currentPath}?${qs}` : currentPath;
  }

  const pages = pageNumbersToRender(page, pageCount);
  const showing = labels.showing
    .replace("{from}", String(from))
    .replace("{to}", String(to))
    .replace("{total}", String(total));

  const prevDisabled = page <= 1;
  const nextDisabled = page >= pageCount;

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 pt-2 text-sm">
      <div className="flex items-center gap-2">
        <label className="text-text-mute" htmlFor="paginator-per">
          {labels.rowsPerPage}
        </label>
        <select
          id="paginator-per"
          defaultValue={perPage}
          onChange={(e) => {
            window.location.href = hrefWith({ per: Number(e.currentTarget.value) });
          }}
          className="h-9 rounded-md border border-border bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        >
          {perPageOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1">
        {prevDisabled ? (
          <span
            aria-disabled
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs text-text-mute opacity-50"
          >
            ← {labels.prev}
          </span>
        ) : (
          <Link
            href={hrefWith({ page: page - 1 })}
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs hover:bg-surface-2"
          >
            ← {labels.prev}
          </Link>
        )}

        {pages.map((p, i) =>
          p === "…" ? (
            <span key={`gap-${i}`} className="px-1 text-text-mute">
              …
            </span>
          ) : p === page ? (
            <span
              key={p}
              aria-current="page"
              className="inline-flex h-8 min-w-8 items-center justify-center rounded-md bg-brand-900 px-2 text-xs font-semibold text-white dark:bg-white dark:text-brand-900"
            >
              {p}
            </span>
          ) : (
            <Link
              key={p}
              href={hrefWith({ page: p })}
              className="inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-border px-2 text-xs hover:bg-surface-2"
            >
              {p}
            </Link>
          ),
        )}

        {nextDisabled ? (
          <span
            aria-disabled
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs text-text-mute opacity-50"
          >
            {labels.next} →
          </span>
        ) : (
          <Link
            href={hrefWith({ page: page + 1 })}
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs hover:bg-surface-2"
          >
            {labels.next} →
          </Link>
        )}
      </div>

      {filterActive || total === 0 ? null : (
        <p className="text-xs text-text-mute" data-testid="paginator-count">
          {showing}
        </p>
      )}
    </nav>
  );
}

/** Which page numbers to render. Always shows 1 and pageCount, plus a
 *  window of ±1 around the current page. Gaps replaced with "…". */
export function pageNumbersToRender(current: number, total: number): Array<number | "…"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, total, current - 1, current, current + 1]);
  const nums = Array.from(set)
    .filter((n) => n >= 1 && n <= total)
    .sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  for (let i = 0; i < nums.length; i++) {
    if (i > 0 && nums[i] - nums[i - 1] > 1) out.push("…");
    out.push(nums[i]);
  }
  return out;
}
