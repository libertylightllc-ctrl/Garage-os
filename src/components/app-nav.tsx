import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { type StaffRole } from "@/lib/roles";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { GarageBrand } from "@/components/garage-brand";
import { NavMore, type MoreItem } from "@/components/nav-more";
import { cookies } from "next/headers";
import { AppShell } from "@/components/nav-shell/AppShell";
import { PART_REQUEST_OPEN_STATUSES } from "@/lib/part-request-open";

/**
 * Per-role migration gate for the new bottom-bar + More-sheet AppShell.
 * Roles listed here render AppShell; others still render the legacy
 * horizontal-strip nav below. Migrate one role at a time per the
 * slice plan (slice 1: MASTER only, slice 2: + TECH + CASHIER, etc.).
 */
const USE_APP_SHELL: Partial<Record<StaffRole, boolean>> = {
    MASTER: true,
    TECH: true,
    CASHIER: true,
    ADVISOR: true,
    OWNER: true,
};

/**
 * Preview-only opt-in: the `nav-preview=1` cookie (set by
 * /api/nav-preview?on) forces the new shell for any signed-in role.
 * Lets a phone tester see the new nav on a Vercel preview URL without
 * needing a MASTER account in prod. Removed alongside USE_APP_SHELL
 * during slice-plan cleanup.
 */
async function shouldForceAppShell(): Promise<boolean> {
    const c = await cookies();
    return c.get("nav-preview")?.value === "1";
}

interface NavItem {
    href: string;
    labelKey: MessageKey;
    key: string;
}

/**
 * Per-role top-bar tabs, split into `primary` (always visible inline) and
 * `more` (tucked under a "More ▾" overflow menu). Roles with a long tab
 * list — OWNER, MASTER, ADVISOR — would otherwise become an unwieldy
 * horizontal scroll on a phone; keeping ~5 core tabs inline and the rest
 * in the menu keeps the header tidy on every screen. TECH/CASHIER have so
 * few tabs they need no overflow (empty `more`).
 */
type RoleNav = { primary: NavItem[]; more: NavItem[] };

const NAV: Record<StaffRole, RoleNav> = {
    OWNER: {
        primary: [
            { href: "/owner", labelKey: "tabDashboard", key: "dashboard" },
            // Solo-owner shops: the owner runs the job flow himself on the
            // advisor screens (their guards admit OWNER). Staff stay optional.
            { href: "/advisor", labelKey: "tabJobs", key: "jobs" },
            { href: "/advisor/jobs/new", labelKey: "tabIntake", key: "intake" },
            { href: "/owner/inventory", labelKey: "tabInventory", key: "inventory" },
            { href: "/owner/analytics", labelKey: "tabAnalytics", key: "analytics" },
        ],
        more: [
            { href: "/owner/branches", labelKey: "tabBranches", key: "branches" },
            { href: "/owner/bays", labelKey: "tabBays", key: "bays" },
            { href: "/owner/staff", labelKey: "tabTeam", key: "team" },
            { href: "/owner/hours", labelKey: "tabHours", key: "hours" },
            { href: "/owner/suppliers", labelKey: "tabSuppliers", key: "suppliers" },
            { href: "/owner/purchasing", labelKey: "tabPurchasing", key: "purchasing" },
            // Accounting hub (E1a0, AR 2026-08-30). Payables moved
            // under this hub alongside the CSV export; Expenses / P&L
            // / VAT / trial balance land here as E1d–E5 ship.
            { href: "/owner/accounting", labelKey: "tabAccounting", key: "accounting" },
            { href: "/owner/billing", labelKey: "tabBilling", key: "billing" },
            { href: "/owner/ledger", labelKey: "tabLedger", key: "ledger" },
            { href: "/owner/whatsapp", labelKey: "tabWhatsapp", key: "whatsapp" },
        ],
    },
    ADVISOR: {
        primary: [
            { href: "/advisor", labelKey: "tabJobs", key: "jobs" },
            { href: "/advisor/estimates", labelKey: "tabEstimates", key: "estimates" },
            { href: "/advisor/vehicles", labelKey: "tabVehicles", key: "vehicles" },
            { href: "/advisor/bookings", labelKey: "tabBookings", key: "bookings" },
            { href: "/advisor/parts", labelKey: "tabParts", key: "parts" },
        ],
        more: [
            { href: "/advisor/reminders", labelKey: "tabReminders", key: "reminders" },
            { href: "/advisor/chats", labelKey: "tabChats", key: "chats" },
            { href: "/advisor/whatsapp", labelKey: "tabWhatsapp", key: "whatsapp" },
        ],
    },
    TECH: {
        primary: [{ href: "/technician", labelKey: "tabWorkshop", key: "workshop" }],
        more: [],
    },
    CASHIER: {
        primary: [
            { href: "/cashier", labelKey: "tabAccounts", key: "accounts" },
            { href: "/cashier/whatsapp", labelKey: "tabWhatsapp", key: "whatsapp" },
        ],
        more: [],
    },
    // MASTER: the full operational floor under one login — the core
    // intake → estimate → cashier flow stays inline; secondary lookups
    // (hours, vehicles, bookings, parts, reminders, chats, whatsapp) go
    // under More. Deliberately NO owner tabs (dashboard, billing, ledger,
    // analytics stay owner-only).
    MASTER: {
        primary: [
            { href: "/advisor", labelKey: "tabJobs", key: "jobs" },
            { href: "/advisor/jobs/new", labelKey: "tabIntake", key: "intake" },
            { href: "/technician", labelKey: "tabWorkshop", key: "workshop" },
            { href: "/advisor/estimates", labelKey: "tabEstimates", key: "estimates" },
            { href: "/cashier", labelKey: "tabAccounts", key: "accounts" },
        ],
        more: [
            { href: "/owner/hours", labelKey: "tabHours", key: "hours" },
            // Accounting hub (E1a0, AR 2026-08-30). MASTER's view of
            // the hub shows Payables + future Expenses; CSV export
            // stays OWNER-only.
            { href: "/owner/accounting", labelKey: "tabAccounting", key: "accounting" },
            { href: "/advisor/vehicles", labelKey: "tabVehicles", key: "vehicles" },
            { href: "/advisor/bookings", labelKey: "tabBookings", key: "bookings" },
            { href: "/advisor/parts", labelKey: "tabParts", key: "parts" },
            { href: "/advisor/reminders", labelKey: "tabReminders", key: "reminders" },
            { href: "/advisor/chats", labelKey: "tabChats", key: "chats" },
            { href: "/advisor/whatsapp", labelKey: "tabWhatsapp", key: "whatsapp" },
        ],
    },
};

/** Consistent staff top bar: brand + role, section tabs, sign out. */
export async function AppNav({ role: pageRole, active }: { role: StaffRole; active?: string }) {
    const t = await getT();

    // Always fetch the signed-in garage's logoUrl (used by GarageBrand
    // below) — one tiny query per page load. Skipping the auth call for
    // non-signed surfaces would be wrong because AppNav only renders
    // for staff who already passed requireRole, so a session always
    // exists. We still null-guard for the type system.
    const session = await auth();

    // Render the SESSION role's nav, not the page's. An OWNER working a
    // shared screen (advisor jobs, cashier queue — their guards admit
    // OWNER for solo-owner shops) keeps the owner tabs and can always get
    // back to the dashboard. For matching roles this is a no-op.
    const role = (session?.user?.role as StaffRole | undefined) ?? pageRole;

    // Per-role delegation to the new AppShell. Keep the fall-through
    // legacy path fully intact until every role is migrated (slice
    // plan) — reverting the migration for any role means removing
    // its entry from USE_APP_SHELL and nothing else. The preview
    // cookie also forces the shell for any role, so a phone tester
    // on a Vercel preview URL can see the new nav as themselves.
    if (USE_APP_SHELL[role] || (await shouldForceAppShell())) {
        return <AppShell role={pageRole} active={active} />;
    }

    const roleNav = NAV[role] ?? NAV[pageRole];
    const garage = session?.user?.garageId
        ? await prisma.garage.findUnique({
              where: { id: session.user.garageId },
              select: { logoUrl: true },
          })
        : null;

    // Advisor: badge Chats (needs-human), Parts (open requests), Reminders (due now).
    let needsHuman = 0;
    let openParts = 0;
    let dueReminders = 0;
    if ((role === "ADVISOR" || role === "MASTER") && session?.user?.garageId) {
        const gid = session.user.garageId;
        [needsHuman, openParts, dueReminders] = await Promise.all([
            prisma.whatsAppThread.count({ where: { garageId: gid, threadStatus: "NEEDS_HUMAN" } }),
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
    }

    // Resolve the badge (count + colour) for a given tab key, or null.
    function badgeFor(key: string): { count: number; className: string } | null {
        if (key === "chats" && needsHuman > 0)
            return { count: needsHuman, className: "bg-danger-500" };
        if (key === "parts" && openParts > 0)
            return { count: openParts, className: "bg-warning-500" };
        if (key === "reminders" && dueReminders > 0)
            return { count: dueReminders, className: "bg-info-500" };
        return null;
    }

    // Pre-resolve the overflow items into serializable props for the
    // client NavMore component (labels + badges resolved server-side).
    const moreItems: MoreItem[] = roleNav.more.map((it) => {
        const badge = badgeFor(it.key);
        return {
            href: it.href,
            label: t(it.labelKey),
            key: it.key,
            badge: badge?.count,
            badgeClass: badge?.className,
        };
    });

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
            // print:hidden — defensive against printable pages that
            // render AppNav. The screen-only role bar has no place on
            // the paper.
            className="sticky top-0 z-40 mb-2 border-b border-border bg-surface/80 backdrop-blur print:hidden"
            style={{
                marginLeft: "calc(50% - 50vw)",
                marginRight: "calc(50% - 50vw)",
            }}
        >
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-3">
                <Link
                    href={roleNav.primary[0].href}
                    className="flex shrink-0 items-center gap-2 text-sm font-semibold tracking-tight"
                    aria-label="Garage Os"
                >
                    {/* Garage brand mark. When the signed-in garage has
                        uploaded a logoUrl, GarageBrand renders that. When
                        null, GarageBrand falls back to the default
                        Garage Os monogram (the same image that used to
                        be hardcoded here). dark:invert + the "Garage Os"
                        wordmark below stay attached only when the
                        DEFAULT brand renders — for an uploaded shop
                        logo, we drop the wordmark since the logo IS the
                        wordmark, and we drop dark:invert since inverting
                        a custom logo's colors would mangle them. */}
                    <div className="flex flex-col items-center gap-0.5 leading-none">
                        <GarageBrand size="mark" logoUrl={garage?.logoUrl ?? null} />
                        {garage?.logoUrl ? null : (
                            <span className="text-[11px] font-semibold tracking-wide">
                                Garage Os
                            </span>
                        )}
                    </div>
                    <span className="hidden whitespace-nowrap font-normal text-text-mute sm:inline">
                        · {t(`role${role}` as MessageKey)}
                    </span>
                </Link>

                <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                    {roleNav.primary.map((it) => {
                        const isActive = active === it.key;
                        const badge = badgeFor(it.key);
                        return (
                            <Link
                                key={it.key}
                                href={it.href}
                                aria-current={isActive ? "page" : undefined}
                                className={
                                    "inline-flex min-h-[40px] items-center whitespace-nowrap rounded-full px-3 py-2 text-sm " +
                                    (isActive
                                        ? "bg-brand-900 text-white dark:bg-white dark:text-brand-900"
                                        : "text-text-mute hover:bg-surface-2")
                                }
                            >
                                {t(it.labelKey)}
                                {badge ? (
                                    <span
                                        className={
                                            "ms-1 rounded-full px-1.5 text-xs text-white " +
                                            badge.className
                                        }
                                    >
                                        {badge.count}
                                    </span>
                                ) : null}
                            </Link>
                        );
                    })}
                    <NavMore label={t("tabMore")} items={moreItems} activeKey={active} />
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
                        className="inline-flex min-h-[40px] items-center whitespace-nowrap rounded-full px-3 py-2 text-sm text-text-mute hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                    >
                        {t("settings")}
                    </Link>
                    <form action={signOutAction}>
                        <button className="inline-flex min-h-[40px] items-center whitespace-nowrap rounded-full px-3 py-2 text-sm text-text-mute hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                            {t("signOut")}
                        </button>
                    </form>
                </div>
            </div>
        </header>
    );
}
