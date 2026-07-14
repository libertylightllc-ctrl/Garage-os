"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export interface BottomTab {
    key: string;
    href: string;
    label: string;
    /** Pre-rendered icon element (server renders the Lucide component). */
    icon: ReactNode;
    badge?: number;
    badgeClass?: string;
}

/**
 * Mobile bottom tab bar — fixed to viewport bottom, 4-5 primary tabs
 * plus (optionally) a "More" tab that opens a bottom sheet. Sized for
 * the thumb zone with min 56px height + iOS safe-area padding, so
 * every tab is comfortably tappable one-handed on a 375px phone.
 *
 * onMoreClick is provided by the parent shell; the sheet itself lives
 * outside this component so state can be lifted for animation.
 */
export function BottomTabBar({
    tabs,
    activeKey,
    moreLabel,
    onMoreClick,
    hasOverflowBadge,
}: {
    tabs: BottomTab[];
    activeKey?: string;
    moreLabel?: string;
    onMoreClick?: () => void;
    hasOverflowBadge?: boolean;
}) {
    const showMore = Boolean(moreLabel && onMoreClick);

    return (
        <nav
            aria-label="Primary"
            className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur md:hidden"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
            <ul className="mx-auto flex max-w-md items-stretch justify-around">
                {tabs.map((t) => {
                    const isActive = t.key === activeKey;
                    return (
                        <li key={t.key} className="flex-1">
                            <Link
                                href={t.href}
                                aria-current={isActive ? "page" : undefined}
                                className={
                                    "relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-2 text-[11px] " +
                                    (isActive
                                        ? "text-brand-900 dark:text-white"
                                        : "text-text-mute hover:text-text")
                                }
                            >
                                <span aria-hidden="true" className="[&_svg]:h-5 [&_svg]:w-5">
                                    {t.icon}
                                </span>
                                <span className="whitespace-nowrap">{t.label}</span>
                                {(t.badge ?? 0) > 0 ? (
                                    <span
                                        className={
                                            "absolute end-2 top-1.5 min-w-[16px] rounded-full px-1 text-center text-[10px] font-semibold text-white " +
                                            (t.badgeClass ?? "bg-danger-500")
                                        }
                                    >
                                        {t.badge}
                                    </span>
                                ) : null}
                            </Link>
                        </li>
                    );
                })}
                {showMore ? (
                    <li className="flex-1">
                        <button
                            type="button"
                            onClick={onMoreClick}
                            aria-label={moreLabel}
                            className="relative flex min-h-[56px] w-full flex-col items-center justify-center gap-0.5 px-1 py-2 text-[11px] text-text-mute hover:text-text"
                        >
                            <MoreHorizontal aria-hidden="true" className="h-5 w-5 opacity-80" />
                            <span className="whitespace-nowrap">{moreLabel}</span>
                            {hasOverflowBadge ? (
                                <span
                                    aria-hidden="true"
                                    className="absolute end-2 top-1.5 h-2 w-2 rounded-full bg-danger-500"
                                />
                            ) : null}
                        </button>
                    </li>
                ) : null}
            </ul>
        </nav>
    );
}
