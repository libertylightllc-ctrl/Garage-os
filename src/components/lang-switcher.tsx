"use client";

import { useRouter } from "next/navigation";

// Sets a `lang` cookie and re-renders server components (preserves the current path).
export function LangSwitcher({ locale }: { locale: string }) {
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
    return (
        // print:hidden — the switcher lives in the root layout and paints
        // on every printed page (over the header on page 1, floating as a
        // grey pill on overflow pages). It's a screen-only affordance.
        // Root-layout floaters must always be print-scoped so a printable
        // page never has to fight the shell for the paper.
        <div className="fixed end-3 top-3 z-50 flex gap-1 rounded-full border border-border bg-surface/80 p-0.5 backdrop-blur print:hidden">
            <button onClick={() => set("en")} className={`${base} ${locale === "en" ? on : off}`}>
                EN
            </button>
            <button onClick={() => set("ar")} className={`${base} ${locale === "ar" ? on : off}`}>
                ع
            </button>
        </div>
    );
}
