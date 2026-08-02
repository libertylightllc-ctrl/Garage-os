"use client";

import { useRouter } from "next/navigation";

/**
 * EN/ع language toggle.
 *
 * Two modes:
 *   - default (`inline` unset / false) — `fixed end-3 top-3` for non-
 *     staff pages that have no top-bar shell (login, customer / public /
 *     home routes). Data attribute `data-lang-switcher-fixed` marks it
 *     so CSS in globals.css can hide it when a staff shell IS present.
 *   - `inline` — renders as a normal inline flex block, no positioning.
 *     Used INSIDE the staff shell (DesktopSideNav brand block +
 *     MobileTopStrip) so the toggle has a proper place in the app's
 *     top bar and never floats over page content.
 *
 * Toggle cookie handling is unchanged either way.
 */
export function LangSwitcher({
    locale,
    inline = false,
}: {
    locale: string;
    inline?: boolean;
}) {
    const router = useRouter();
    function set(l: string) {
        // Cookie scope: parent-domain on prod so the cookie survives
        // any bounce between apex (`garageos.shop`) and www
        // (`www.garageos.shop`) — Vercel 308-redirects apex → www, but
        // a host-only cookie set on www is invisible to a subsequent
        // request that arrives on apex first. Scoping to
        // `.garageos.shop` makes the cookie readable on both hosts.
        //
        // Localhost gets NO `domain=` attribute — a `domain=localhost`
        // (or `.localhost`) attribute is silently dropped by every
        // major browser, which would break the toggle in local dev.
        // Host-only is the correct scope for a single-host dev server.
        //
        // See docs/apex-www-cookie-scope-spec.md for the class of bug
        // this addresses and the auth-session cookie that shares it.
        const host = window.location.hostname;
        const isGarageosShop =
            host === "garageos.shop" || host.endsWith(".garageos.shop");
        const domainAttr = isGarageosShop ? ";domain=.garageos.shop" : "";
        const secureAttr = window.location.protocol === "https:" ? ";secure" : "";
        document.cookie = `lang=${l};path=/${domainAttr};samesite=lax${secureAttr};max-age=31536000`;
        router.refresh();
    }
    const base = "px-2 py-0.5 text-xs rounded";
    const on = "bg-brand-900 text-white dark:bg-white dark:text-brand-900";
    const off = "text-text-mute";
    // Common visual — used by both fixed and inline shapes. The
    // `data-lang-switcher-fixed` attribute lets globals.css hide the
    // root-layout fixed instance when a staff shell (which renders its
    // own inline instance in the top bar) is present in the DOM.
    // print:hidden — the switcher paints over headers on printed pages;
    // always scope to screen-only.
    const inner = (
        <>
            <button onClick={() => set("en")} className={`${base} ${locale === "en" ? on : off}`}>
                EN
            </button>
            <button onClick={() => set("ar")} className={`${base} ${locale === "ar" ? on : off}`}>
                ع
            </button>
        </>
    );
    if (inline) {
        return (
            <div className="flex gap-1 rounded-full border border-border bg-surface/80 p-0.5 backdrop-blur print:hidden">
                {inner}
            </div>
        );
    }
    return (
        <div
            data-lang-switcher-fixed="1"
            className="fixed end-3 top-3 z-50 flex gap-1 rounded-full border border-border bg-surface/80 p-0.5 backdrop-blur print:hidden"
        >
            {inner}
        </div>
    );
}
