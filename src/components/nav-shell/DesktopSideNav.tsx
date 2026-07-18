import Link from "next/link";
import type { ReactNode } from "react";
import { Settings as SettingsIcon, LogOut } from "lucide-react";
import { signOutAction } from "@/app/actions/auth";
import { GarageBrand } from "@/components/garage-brand";

export interface SideNavItem {
    key: string;
    href: string;
    label: string;
    /** Pre-rendered icon element (server renders the Lucide component). */
    icon: ReactNode;
    badge?: number;
    badgeClass?: string;
}

/**
 * Desktop-only left side nav (hidden on mobile). Fixed to the viewport
 * left edge, 220px wide, holds the brand mark + role label + all nav
 * items (both primary and overflow shown together, since desktop has
 * room). Settings + Sign out sit at the bottom in a divider block.
 *
 * Pages that use AppShell must add left padding on md+ so their
 * content doesn't sit under this nav (see AppShell).
 */
export function DesktopSideNav({
    logoUrl,
    roleLabel,
    settingsLabel,
    signOutLabel,
    items,
    activeKey,
}: {
    logoUrl: string | null;
    roleLabel: string;
    settingsLabel: string;
    signOutLabel: string;
    items: SideNavItem[];
    activeKey?: string;
}) {
    return (
        <aside
            aria-label="Primary"
            // data-app-shell is the marker that lets globals.css add the
            // 220px inline-start padding to <body> ONLY when this side
            // nav is in the DOM. Do NOT rename or remove this attribute —
            // the layout centring of every public + login + customer
            // page depends on it staying absent from their DOM.
            // Pinned by src/components/nav-shell/__tests__/shell-padding-markers.test.ts.
            data-app-shell="1"
            className="fixed inset-y-0 start-0 z-30 hidden w-[220px] flex-col border-e border-border bg-surface md:flex"
        >
            {/* Brand block */}
            <div className="flex items-center gap-2 border-b border-border px-4 py-4">
                <GarageBrand size="mark" logoUrl={logoUrl} />
                <div className="flex flex-col leading-tight">
                    {logoUrl ? null : (
                        <span className="text-[13px] font-semibold tracking-tight">
                            Garage Os
                        </span>
                    )}
                    <span className="text-[11px] text-text-mute">{roleLabel}</span>
                </div>
            </div>

            {/* Nav items — scrollable if long */}
            <nav className="flex-1 overflow-y-auto px-2 py-3">
                <ul className="flex flex-col gap-0.5">
                    {items.map((it) => {
                        const isActive = it.key === activeKey;
                        return (
                            <li key={it.key}>
                                <Link
                                    href={it.href}
                                    aria-current={isActive ? "page" : undefined}
                                    className={
                                        "relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm " +
                                        (isActive
                                            ? "bg-brand-900 text-white dark:bg-white dark:text-brand-900"
                                            : "text-text-mute hover:bg-surface-2 hover:text-text")
                                    }
                                >
                                    <span
                                        aria-hidden="true"
                                        className="opacity-80 [&_svg]:h-4 [&_svg]:w-4"
                                    >
                                        {it.icon}
                                    </span>
                                    <span className="whitespace-nowrap">{it.label}</span>
                                    {(it.badge ?? 0) > 0 ? (
                                        <span
                                            className={
                                                "ms-auto rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-white " +
                                                (it.badgeClass ?? "bg-danger-500")
                                            }
                                        >
                                            {it.badge}
                                        </span>
                                    ) : null}
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            </nav>

            {/* Account block */}
            <div className="border-t border-border px-2 py-2">
                <ul className="flex flex-col gap-0.5">
                    <li>
                        <Link
                            href="/settings"
                            className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-text-mute hover:bg-surface-2 hover:text-text"
                        >
                            <SettingsIcon className="h-4 w-4" aria-hidden="true" />
                            {settingsLabel}
                        </Link>
                    </li>
                    <li>
                        <form action={signOutAction}>
                            <button
                                type="submit"
                                className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-text-mute hover:bg-surface-2 hover:text-text"
                            >
                                <LogOut className="h-4 w-4" aria-hidden="true" />
                                {signOutLabel}
                            </button>
                        </form>
                    </li>
                </ul>
            </div>
        </aside>
    );
}
