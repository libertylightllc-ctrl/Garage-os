import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";
import { ROLE_TITLE, type StaffRole } from "@/lib/roles";

interface NavItem {
  href: string;
  label: string;
  key: string;
}

const NAV: Record<StaffRole, NavItem[]> = {
  OWNER: [
    { href: "/owner", label: "Dashboard", key: "dashboard" },
    { href: "/owner/staff", label: "Team", key: "team" },
  ],
  ADVISOR: [
    { href: "/advisor", label: "Jobs", key: "jobs" },
    { href: "/advisor/bookings", label: "Bookings", key: "bookings" },
  ],
  TECH: [{ href: "/technician", label: "Workshop", key: "workshop" }],
  ACCOUNTANT: [{ href: "/accountant", label: "Accounts", key: "accounts" }],
};

/** Consistent staff top bar: brand + role, section tabs, sign out. */
export function AppNav({ role, active }: { role: StaffRole; active?: string }) {
  const items = NAV[role];
  return (
    <header className="sticky top-0 z-40 -mx-6 mb-2 border-b border-black/10 bg-white/80 px-6 py-3 backdrop-blur dark:border-white/15 dark:bg-black/60">
      <div className="flex items-center justify-between gap-3">
        <Link href={items[0].href} className="text-sm font-semibold tracking-tight">
          GarageOS
          <span className="ms-2 font-normal text-zinc-500 dark:text-zinc-400">{ROLE_TITLE[role]}</span>
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
                {it.label}
              </Link>
            );
          })}
          <form action={signOutAction} className="ms-1">
            <button className="whitespace-nowrap rounded-full px-3 py-1 text-sm text-zinc-500 hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/10">
              Sign out
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}
