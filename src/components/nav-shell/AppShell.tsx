import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { type StaffRole } from "@/lib/roles";
import { NAV, type NavItem } from "@/config/nav";
import { PART_REQUEST_OPEN_STATUSES } from "@/lib/part-request-open";
import { MobileTopStrip } from "./MobileTopStrip";
import { DesktopSideNav } from "./DesktopSideNav";
import { MobileNavClient } from "./MobileNavClient";
import { VersionCheck } from "@/components/version-check";
import type { BottomTab } from "./BottomTabBar";
import type { MoreSheetItem } from "./MoreSheet";
import type { SideNavItem } from "./DesktopSideNav";

/**
 * The new nav shell — mobile-first, thumb-zone bottom bar + "More"
 * bottom sheet + desktop left side nav. Renders in place of the
 * legacy AppNav for roles that have been migrated (see app-nav.tsx
 * switch — MASTER only during slice 1, expanding per the slice plan).
 *
 * Same public props as AppNav (`role`, `active`) so it's a drop-in.
 * On md+ this adds a permanent side nav that eats 220px of left space;
 * consumer pages already use their own content max-w so this is fine.
 */
export async function AppShell({
    role: pageRole,
    active,
}: {
    role: StaffRole;
    active?: string;
}) {
    const t = await getT();
    const session = await auth();

    // Session role wins over page role for solo-owner scenarios.
    const role = (session?.user?.role as StaffRole | undefined) ?? pageRole;
    const roleNav = NAV[role] ?? NAV[pageRole];

    // Nav shell must render even when the DB flakes — otherwise the
    // whole app renders "Something went wrong" for a transient
    // Prisma glitch. Both queries below fall back to safe defaults on
    // failure; the shell still shows tabs + sign-out.
    let garage: { logoUrl: string | null } | null = null;
    if (session?.user?.garageId) {
        try {
            garage = await prisma.garage.findUnique({
                where: { id: session.user.garageId },
                select: { logoUrl: true },
            });
        } catch (e) {
            console.error("[AppShell] garage logo fetch failed:", e);
        }
    }

    // Advisor + Master: badge chats (needs-human), parts (open),
    // reminders (due). Same counters as legacy AppNav.
    let needsHuman = 0;
    let openParts = 0;
    let dueReminders = 0;
    if ((role === "ADVISOR" || role === "MASTER") && session?.user?.garageId) {
        const gid = session.user.garageId;
        try {
            [needsHuman, openParts, dueReminders] = await Promise.all([
                prisma.whatsAppThread.count({
                    where: { garageId: gid, threadStatus: "NEEDS_HUMAN" },
                }),
                prisma.partRequest.count({
                    where: {
                        garageId: gid,
                        status: { in: [...PART_REQUEST_OPEN_STATUSES] },
                    },
                }),
                prisma.reminder.count({
                    where: { garageId: gid, status: "SCHEDULED", dueAt: { lte: new Date() } },
                }),
            ]);
        } catch (e) {
            console.error("[AppShell] nav badge counts failed:", e);
            // fall through with zeros already assigned
        }
    }

    function badgeFor(item: NavItem): { count: number; className: string } | null {
        if (item.badge === "needsHuman" && needsHuman > 0)
            return { count: needsHuman, className: "bg-danger-500" };
        if (item.badge === "openParts" && openParts > 0)
            return { count: openParts, className: "bg-warning-500" };
        if (item.badge === "dueReminders" && dueReminders > 0)
            return { count: dueReminders, className: "bg-info-500" };
        return null;
    }

    // Pre-render icons here (server side) so the client components
    // receive them as ReactNode. Passing the raw Lucide function
    // component as a prop across the RSC boundary fails with
    // "Functions cannot be passed directly to Client Components".
    const primaryTabs: BottomTab[] = roleNav.primary.map((it) => {
        const b = badgeFor(it);
        const Icon = it.icon;
        return {
            key: it.key,
            href: it.href,
            label: t(it.labelKey),
            icon: <Icon />,
            badge: b?.count,
            badgeClass: b?.className,
        };
    });

    const overflowItems: MoreSheetItem[] = roleNav.overflow.map((it) => {
        const b = badgeFor(it);
        const Icon = it.icon;
        return {
            key: it.key,
            href: it.href,
            label: t(it.labelKey),
            icon: <Icon />,
            badge: b?.count,
            badgeClass: b?.className,
        };
    });

    const desktopItems: SideNavItem[] = [...roleNav.primary, ...roleNav.overflow].map(
        (it) => {
            const b = badgeFor(it);
            const Icon = it.icon;
            return {
                key: it.key,
                href: it.href,
                label: t(it.labelKey),
                icon: <Icon />,
                badge: b?.count,
                badgeClass: b?.className,
            };
        },
    );

    // Signal on the More button when a hidden overflow item has a
    // pending badge (so the user knows to open the sheet).
    const hasOverflowBadge = overflowItems.some((it) => (it.badge ?? 0) > 0);

    const roleLabel = t(`role${role}` as MessageKey);
    const settingsLabel = t("settings");
    const signOutLabel = t("signOut");
    const moreLabel = t("tabMore");

    return (
        <>
            <MobileTopStrip logoUrl={garage?.logoUrl ?? null} roleLabel={roleLabel} />
            <DesktopSideNav
                logoUrl={garage?.logoUrl ?? null}
                roleLabel={roleLabel}
                settingsLabel={settingsLabel}
                signOutLabel={signOutLabel}
                items={desktopItems}
                activeKey={active}
            />
            <MobileNavClient
                tabs={primaryTabs}
                activeKey={active}
                moreItems={overflowItems}
                moreLabel={moreLabel}
                settingsLabel={settingsLabel}
                signOutLabel={signOutLabel}
                hasOverflowBadge={hasOverflowBadge}
            />
            {/*  Bottom-bar clearance for mobile is applied via body's
                 pb-[calc(4rem+env(safe-area-inset-bottom))] in
                 src/app/layout.tsx — a spacer here would sit at the
                 top of the page (since AppNav renders as the first
                 child of <main>), not the bottom, and did nothing to
                 clear the last row's actions on the cashier
                 Receivables list. */}
            {/* AR 2026-08-25 Batch E — deploy-freshness check for
                staff tabs left open across a deploy. Fetches
                /api/version on focus / visibility change / 5-min
                interval and logs every mismatch to
                /api/version/log. Banner renders only when
                NEXT_PUBLIC_VERSION_BANNER_ENABLED === "1" (ship
                hidden, enable via Vercel env after a week of clean
                logs). Deliberately mounted inside AppShell — every
                authenticated staff route renders through here, and
                no customer-facing surface does. */}
            <VersionCheck
                labels={{
                    message: t("versionCheckMessage"),
                    reload: t("versionCheckReload"),
                    dismiss: t("versionCheckDismiss"),
                }}
            />
        </>
    );
}
