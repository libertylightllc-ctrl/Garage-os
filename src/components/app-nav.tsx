import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { type StaffRole } from "@/lib/roles";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";

interface NavItem {
    href: string;
    labelKey: MessageKey;
    key: string;
}

const NAV: Record<StaffRole, NavItem[]> = {
    OWNER: [
        { href: "/owner", labelKey: "tabDashboard", key: "dashboard" },
        { href: "/owner/branches", labelKey: "tabBranches", key: "branches" },
        { href: "/owner/bays", labelKey: "tabBays", key: "bays" },
        { href: "/owner/staff", labelKey: "tabTeam", key: "team" },
        { href: "/owner/billing", labelKey: "tabBilling", key: "billing" },
        { href: "/owner/ledger", labelKey: "tabLedger", key: "ledger" },
        { href: "/owner/analytics", labelKey: "tabAnalytics", key: "analytics" },
        { href: "/owner/whatsapp", labelKey: "tabWhatsapp", key: "whatsapp" },
    ],
    ADVISOR: [
        { href: "/advisor", labelKey: "tabJobs", key: "jobs" },
        { href: "/advisor/vehicles", labelKey: "tabVehicles", key: "vehicles" },
        { href: "/advisor/bookings", labelKey: "tabBookings", key: "bookings" },
        { href: "/advisor/parts", labelKey: "tabParts", key: "parts" },
        { href: "/advisor/reminders", labelKey: "tabReminders", key: "reminders" },
        { href: "/advisor/chats", labelKey: "tabChats", key: "chats" },
        { href: "/advisor/whatsapp", labelKey: "tabWhatsapp", key: "whatsapp" },
    ],
    TECH: [{ href: "/technician", labelKey: "tabWorkshop", key: "workshop" }],
    CASHIER: [
        { href: "/cashier", labelKey: "tabAccounts", key: "accounts" },
        { href: "/cashier/whatsapp", labelKey: "tabWhatsapp", key: "whatsapp" },
    ],
};

/** Consistent staff top bar: brand + role, section tabs, sign out. */
export async function AppNav({ role, active }: { role: StaffRole; active?: string }) {
    const items = NAV[role];
    const t = await getT();

    // Advisor: badge Chats (needs-human), Parts (open requests), Reminders (due now).
    let needsHuman = 0;
    let openParts = 0;
    let dueReminders = 0;
    if (role === "ADVISOR") {
        const session = await auth();
        if (session?.user?.garageId) {
            const gid = session.user.garageId;
            [needsHuman, openParts, dueReminders] = await Promise.all([
                prisma.whatsAppThread.count({ where: { garageId: gid, threadStatus: "NEEDS_HUMAN" } }),
                prisma.partRequest.count({
                    where: { garageId: gid, status: { in: ["REQUESTED", "ORDERED", "ARRIVED"] } },
                }),
                prisma.reminder.count({
                    where: { garageId: gid, status: "SCHEDULED", dueAt: { lte: new Date() } },
                }),
            ]);
        }
    }
    // Header BREAKS OUT of the per-page main container so it spans the
    // full viewport width on every screen, not just the page max-w.
    // `marginLeft: calc(50% - 50vw)` on each side is the classic
    // full-bleed escape: each side gets a negative margin equal to half
    // the gap between parent width and viewport, then w-screen
    // explicitly claims 100vw. Works regardless of whether the page is
    // max-w-xl or max-w-7xl — the header always reaches the viewport
    // edges. Inner div takes over content centering with its own
    // max-w-7xl + mx-auto + px-6 + py-3 so the brand + nav + sign out
    // sit in a sensible content column even on a 1920px monitor. On
    // phones below max-w-7xl the inner just fills the viewport,
    // identical to pre-fix behaviour. Inline style (not arbitrary
    // Tailwind class) because `calc(50% - 50vw)` contains a `%` that
    // breaks the JSX class-string parser.
    return (
        <header
            className="sticky top-0 z-40 mb-2 border-b border-border bg-surface/80 backdrop-blur"
            style={{
                marginLeft: "calc(50% - 50vw)",
                marginRight: "calc(50% - 50vw)",
            }}
        >
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-3">
                <Link
                    href={items[0].href}
                    className="flex shrink-0 items-center gap-2 text-sm font-semibold tracking-tight"
                    aria-label="Garage Os"
                >
                    {/* Garage OS brand mark — calligraphic Go monogram.
                        Plain <img> (not next/image) so the public SVG is
                        served as-is, no build-time optimisation step.
                        h-8 caps the height (32px) to fit the nav bar;
                        w-auto preserves aspect ratio. dark:invert flips
                        the #111 fill to white on dark backgrounds. */}
                    <div className="flex flex-col items-center gap-0.5 leading-none">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src="/brand/garageos-mark.png"
                            alt=""
                            className="h-8 w-auto dark:invert"
                        />
                        <span className="text-[11px] font-semibold tracking-wide">
                            Garage Os
                        </span>
                    </div>
                    <span className="hidden whitespace-nowrap font-normal text-text-mute sm:inline">
                        · {t(`role${role}` as MessageKey)}
                    </span>
                </Link>

                <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                    {items.map((it) => {
                        const isActive = active === it.key;
                        return (
                            <Link
                                key={it.key}
                                href={it.href}
                                aria-current={isActive ? "page" : undefined}
                                className={
                                    "whitespace-nowrap rounded-full px-3 py-1 text-sm " +
                                    (isActive
                                        ? "bg-brand-900 text-white dark:bg-white dark:text-brand-900"
                                        : "text-text-mute hover:bg-surface-2")
                                }
                            >
                                {t(it.labelKey)}
                                {it.key === "chats" && needsHuman > 0 ? (
                                    <span className="ms-1 rounded-full bg-danger-500 px-1.5 text-xs text-white">
                                        {needsHuman}
                                    </span>
                                ) : null}
                                {it.key === "parts" && openParts > 0 ? (
                                    <span className="ms-1 rounded-full bg-warning-500 px-1.5 text-xs text-white">
                                        {openParts}
                                    </span>
                                ) : null}
                                {it.key === "reminders" && dueReminders > 0 ? (
                                    <span className="ms-1 rounded-full bg-info-500 px-1.5 text-xs text-white">
                                        {dueReminders}
                                    </span>
                                ) : null}
                            </Link>
                        );
                    })}
                </nav>

                {/* Account action — Sign out lives OUTSIDE the scrolling
                    tab strip so it's always reachable in the corner of
                    the header, identical position on every role/screen.
                    Uses logical properties (border-s / ps) so it sits
                    after the nav in LTR and before it in RTL/Arabic
                    automatically, never crowding the brand mark or
                    tabs. shrink-0 keeps it from being compressed when
                    the nav fills available space. */}
                <div className="shrink-0 flex items-center gap-1 border-s border-border ps-3">
                    <Link
                        href="/settings"
                        className="whitespace-nowrap rounded-full px-3 py-1 text-sm text-text-mute hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                    >
                        {t("settings")}
                    </Link>
                    <form action={signOutAction}>
                        <button className="whitespace-nowrap rounded-full px-3 py-1 text-sm text-text-mute hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                            {t("signOut")}
                        </button>
                    </form>
                </div>
            </div>
        </header>
    );
}
