"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** One overflow entry — already translated + badge-resolved server-side so
 *  this client component stays a dumb, serializable renderer. */
export interface MoreItem {
    href: string;
    label: string;
    key: string;
    badge?: number;
    /** Tailwind bg class for the badge pill, e.g. "bg-danger-500". */
    badgeClass?: string;
}

/**
 * The "More ▾" overflow menu for the staff top bar. Roles with many tabs
 * (OWNER, MASTER, ADVISOR) keep their most-used tabs inline and tuck the
 * rest in here so the header never becomes a 12-item horizontal scroll on
 * a phone. Closes on outside-click and whenever the route changes.
 */
export function NavMore({
    label,
    items,
    activeKey,
}: {
    label: string;
    items: MoreItem[];
    activeKey?: string;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const pathname = usePathname();

    const containsActive = items.some((it) => it.key === activeKey);
    const hasBadge = items.some((it) => (it.badge ?? 0) > 0);

    // Close when navigating to a new route (clicking any item).
    useEffect(() => {
        setOpen(false);
    }, [pathname]);

    // Close on outside click / Escape while open.
    useEffect(() => {
        if (!open) return;
        function onDown(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") setOpen(false);
        }
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    if (items.length === 0) return null;

    return (
        <div className="relative shrink-0" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                className={
                    "inline-flex min-h-[40px] items-center gap-1 whitespace-nowrap rounded-full px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60 " +
                    (containsActive
                        ? "bg-brand-900 text-white dark:bg-white dark:text-brand-900"
                        : "text-text-mute hover:bg-surface-2")
                }
            >
                {label}
                <span aria-hidden="true" className="text-xs">
                    ▾
                </span>
                {/* When a badged item (chats / parts / reminders) is hidden in
                    here, surface a small dot so urgency isn't buried. */}
                {hasBadge && !containsActive ? (
                    <span
                        aria-hidden="true"
                        className="ms-0.5 h-2 w-2 rounded-full bg-danger-500"
                    />
                ) : null}
            </button>

            {open ? (
                <div
                    role="menu"
                    className="absolute end-0 z-50 mt-1 min-w-[13rem] rounded-2xl border border-border bg-surface p-1 shadow-lg"
                >
                    {items.map((it) => {
                        const isActive = it.key === activeKey;
                        return (
                            <Link
                                key={it.key}
                                href={it.href}
                                role="menuitem"
                                aria-current={isActive ? "page" : undefined}
                                onClick={() => setOpen(false)}
                                className={
                                    "flex min-h-[44px] items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-sm " +
                                    (isActive
                                        ? "bg-brand-900 text-white dark:bg-white dark:text-brand-900"
                                        : "text-text hover:bg-surface-2")
                                }
                            >
                                <span className="whitespace-nowrap">{it.label}</span>
                                {(it.badge ?? 0) > 0 ? (
                                    <span
                                        className={
                                            "rounded-full px-1.5 text-xs text-white " +
                                            (it.badgeClass ?? "bg-danger-500")
                                        }
                                    >
                                        {it.badge}
                                    </span>
                                ) : null}
                            </Link>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
}
