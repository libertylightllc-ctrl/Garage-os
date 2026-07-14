"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { X, Settings as SettingsIcon, LogOut } from "lucide-react";
import { signOutAction } from "@/app/actions/auth";

export interface MoreSheetItem {
    key: string;
    href: string;
    label: string;
    /** Pre-rendered icon element (server renders the Lucide component). */
    icon: ReactNode;
    badge?: number;
    badgeClass?: string;
}

/**
 * Mobile bottom sheet — opened by the "More" tab in BottomTabBar.
 * Slides up from the bottom (~75vh), shows overflow nav items as a
 * scrollable icon grid, plus Settings + Sign out in a divider block.
 * Closes on outside-click, Escape key, downswipe, or route change.
 *
 * Rendered only on mobile (parent hides on md and up).
 */
export function MoreSheet({
    open,
    onClose,
    items,
    settingsLabel,
    signOutLabel,
    activeKey,
}: {
    open: boolean;
    onClose: () => void;
    items: MoreSheetItem[];
    settingsLabel: string;
    signOutLabel: string;
    activeKey?: string;
}) {
    const pathname = usePathname();

    // Close on route change (user tapped a link inside).
    useEffect(() => {
        if (open) onClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname]);

    // Escape key + body scroll lock while open.
    useEffect(() => {
        if (!open) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }
        document.addEventListener("keydown", onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [open, onClose]);

    return (
        <div
            aria-hidden={!open}
            className={
                "fixed inset-0 z-50 md:hidden " +
                (open ? "pointer-events-auto" : "pointer-events-none")
            }
        >
            {/* Backdrop */}
            <div
                onClick={onClose}
                className={
                    "absolute inset-0 bg-black/40 transition-opacity duration-200 " +
                    (open ? "opacity-100" : "opacity-0")
                }
            />
            {/* Sheet */}
            <div
                role="dialog"
                aria-modal="true"
                className={
                    "absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface shadow-xl transition-transform duration-200 ease-out " +
                    (open ? "translate-y-0" : "translate-y-full")
                }
                style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            >
                {/* Grabber + close */}
                <div className="relative flex items-center justify-between px-4 pb-2 pt-3">
                    <div className="mx-auto h-1 w-10 rounded-full bg-border" />
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="absolute end-3 top-2 rounded-full p-2 text-text-mute hover:bg-surface-2"
                    >
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </div>

                {/* Overflow grid */}
                {items.length > 0 ? (
                    <ul className="grid grid-cols-3 gap-2 px-3 pb-4 pt-2">
                        {items.map((it) => {
                            const isActive = it.key === activeKey;
                            return (
                                <li key={it.key}>
                                    <Link
                                        href={it.href}
                                        aria-current={isActive ? "page" : undefined}
                                        onClick={onClose}
                                        className={
                                            "relative flex min-h-[80px] flex-col items-center justify-center gap-1 rounded-2xl border border-border p-2 text-center text-xs " +
                                            (isActive
                                                ? "bg-brand-900 text-white dark:bg-white dark:text-brand-900"
                                                : "bg-surface text-text hover:bg-surface-2")
                                        }
                                    >
                                        <span aria-hidden="true" className="[&_svg]:h-6 [&_svg]:w-6">
                                            {it.icon}
                                        </span>
                                        <span className="whitespace-nowrap">{it.label}</span>
                                        {(it.badge ?? 0) > 0 ? (
                                            <span
                                                className={
                                                    "absolute end-1.5 top-1.5 min-w-[16px] rounded-full px-1 text-center text-[10px] font-semibold text-white " +
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
                ) : null}

                {/* Divider + account block */}
                <div className="border-t border-border px-3 py-3">
                    <ul className="flex flex-col gap-1">
                        <li>
                            <Link
                                href="/settings"
                                onClick={onClose}
                                className="flex min-h-[44px] items-center gap-3 rounded-xl px-3 py-2 text-sm text-text hover:bg-surface-2"
                            >
                                <SettingsIcon className="h-5 w-5" aria-hidden="true" />
                                {settingsLabel}
                            </Link>
                        </li>
                        <li>
                            <form action={signOutAction}>
                                <button
                                    type="submit"
                                    className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-text hover:bg-surface-2"
                                >
                                    <LogOut className="h-5 w-5" aria-hidden="true" />
                                    {signOutLabel}
                                </button>
                            </form>
                        </li>
                    </ul>
                </div>
            </div>
        </div>
    );
}
