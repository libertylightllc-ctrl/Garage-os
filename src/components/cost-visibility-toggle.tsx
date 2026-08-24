import Link from "next/link";

/**
 * Cost + margin visibility toggle. URL-param driven, SERVER-side.
 *
 * The toggle flips a `?showCost=1` param on the current page URL.
 * The page reads that param and passes `includeCost` into the
 * loader. When off, the loader returns null for every cost/margin
 * field — the numbers never reach the client HTML.
 *
 * AR 2026-08-25 verify: the previous client-side CSS toggle left
 * the cost numbers in the server-rendered payload for anyone who
 * view-sourced. Same class of leak as the cashier cost fix.
 *
 * Rendered as two `<Link>`s (on / off) so state survives page
 * refresh, back/forward, print (browser prints whatever the URL
 * currently shows), and copy-paste of the URL to a colleague. No
 * client JS, no cookies, no state to reason about.
 *
 * Callers pass the base pathname + the current searchParams as an
 * object so any other params on the page (e.g. `?asOf=` on the
 * statement) survive the toggle click. AR 2026-08-25.
 */
export function CostVisibilityToggle({
    basePath,
    currentParams,
    showCost,
}: {
    /** Page pathname without query, e.g. `/advisor/customers/abc/statement`. */
    basePath: string;
    /** All existing search params on the page. We rebuild the query
     *  from these so the `?showCost=` flip preserves everything else. */
    currentParams: Record<string, string | undefined>;
    /** Current state — the page has already read `?showCost=1` (or not)
     *  and passed the resolved boolean here. */
    showCost: boolean;
}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(currentParams)) {
        if (k === "showCost") continue; // we set this ourselves
        if (v != null && v !== "") params.set(k, v);
    }
    if (!showCost) params.set("showCost", "1");
    // else: OFF state — drop the param entirely to leave a clean URL.
    const nextHref = `${basePath}${params.toString() ? `?${params}` : ""}`;

    return (
        <Link
            href={nextHref}
            className="print:hidden inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-xs font-semibold hover:bg-surface-3"
            // No client JS. Reload happens through the standard link.
            prefetch={false}
        >
            {showCost ? "◉" : "○"} {showCost ? "Hide cost + margin" : "Show cost + margin"}
        </Link>
    );
}
