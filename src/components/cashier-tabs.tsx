"use client";

import Link from "next/link";

// Five-tab nav for the cashier dashboard. URL-driven (?tab=…) so the
// browser back button and deep-linking both work. Server reads the
// searchParam and conditionally renders the matching section group.
//
// This is a client component only because Next.js requires usePathname
// or the active class to be computed at render time relative to the
// URL — passing `currentTab` in from the server is cleaner and lets us
// keep this purely presentational. So we accept currentTab as a prop.

export type CashierTab =
  | "estimates"
  | "invoices"
  | "payments"
  | "customers"
  | "reports";

export const CASHIER_TABS: CashierTab[] = [
  "estimates",
  "invoices",
  "payments",
  "customers",
  "reports",
];

export interface CashierTabsLabels {
  estimates: string;
  invoices: string;
  payments: string;
  customers: string;
  reports: string;
}

export function CashierTabs({
  currentTab,
  labels,
}: {
  currentTab: CashierTab;
  labels: CashierTabsLabels;
}) {
  return (
    // Pill-style nav: full-width strip, horizontal scroll on narrow
    // phones, active pill in inverted colour to match the existing
    // GarageOS top-nav treatment.
    <nav className="-mx-6 overflow-x-auto px-6">
      <div className="flex min-w-max items-center gap-1 border-b border-black/10 pb-2 dark:border-white/15">
        {CASHIER_TABS.map((tab) => {
          const isActive = tab === currentTab;
          // Estimates is the default; we omit ?tab=estimates from the URL
          // so the canonical /cashier URL still works and refreshes land
          // back on the default tab.
          const href = tab === "estimates" ? "/cashier" : `/cashier?tab=${tab}`;
          return (
            <Link
              key={tab}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={
                "whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition " +
                (isActive
                  ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                  : "text-zinc-600 hover:bg-black/5 dark:text-zinc-300 dark:hover:bg-white/10")
              }
            >
              {labels[tab]}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
