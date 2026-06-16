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
    return (
        <header className="sticky top-0 z-40 -mx-6 mb-2 border-b border-black/10 bg-white/80 px-6 py-3 backdrop-blur dark:border-white/15 dark:bg-black/60">
            <div className="flex items-center justify-between gap-3">
                <Link href={items[0].href} className="text-sm font-semibold tracking-tight">
                    GarageOS
                    <span className="ms-2 font-normal text-zinc-500 dark:text-zinc-400">
                        {t(`role${role}` as MessageKey)}
                    </span>
                </Link>

                <nav className="flex items-center gap-1 overflow-x-auto">
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
                                        ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                                        : "text-zinc-600 hover:bg-black/5 dark:text-zinc-300 dark:hover:bg-white/10")
                                }
                            >
                                {t(it.labelKey)}
                                {it.key === "chats" && needsHuman > 0 ? (
                                    <span className="ms-1 rounded-full bg-red-500 px-1.5 text-xs text-white">
                                        {needsHuman}
                                    </span>
                                ) : null}
                                {it.key === "parts" && openParts > 0 ? (
                                    <span className="ms-1 rounded-full bg-amber-500 px-1.5 text-xs text-white">
                                        {openParts}
                                    </span>
                                ) : null}
                                {it.key === "reminders" && dueReminders > 0 ? (
                                    <span className="ms-1 rounded-full bg-blue-500 px-1.5 text-xs text-white">
                                        {dueReminders}
                                    </span>
                                ) : null}
                            </Link>
                        );
                    })}
                    <form action={signOutAction} className="ms-1">
                        <button className="whitespace-nowrap rounded-full px-3 py-1 text-sm text-zinc-500 hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/10">
                            {t("signOut")}
                        </button>
                    </form>
                </nav>
            </div>
        </header>
    );
}
