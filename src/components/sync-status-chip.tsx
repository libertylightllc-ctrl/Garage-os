// Small, tooltip-carrying badge for ERPNext sync state.
// Used on /invoices/[id] and can be reused on /cashier / owner
// pages. Print-safe: `print:hidden` so paper documents never
// carry sync-state clutter.

import type { SyncBadge } from "@/lib/erp-sync/status";

const COLOURS: Record<SyncBadge, { dot: string; text: string; ring: string; label: string }> = {
    green: {
        dot: "bg-emerald-500",
        text: "text-emerald-700 dark:text-emerald-400",
        ring: "ring-emerald-500/30",
        label: "Synced",
    },
    amber: {
        dot: "bg-amber-500",
        text: "text-amber-700 dark:text-amber-400",
        ring: "ring-amber-500/30",
        label: "Syncing",
    },
    red: {
        dot: "bg-red-500",
        text: "text-red-700 dark:text-red-400",
        ring: "ring-red-500/30",
        label: "Sync failed",
    },
    grey: {
        dot: "bg-zinc-400",
        text: "text-zinc-600 dark:text-zinc-400",
        ring: "ring-zinc-400/30",
        label: "Not synced",
    },
};

export function SyncStatusChip({
    badge,
    hint,
}: {
    badge: SyncBadge;
    hint: string;
}) {
    const c = COLOURS[badge];
    return (
        <span
            title={hint}
            aria-label={`ERPNext ${c.label}: ${hint}`}
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${c.ring} ${c.text} print:hidden`}
            data-erp-sync={badge}
        >
            <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} aria-hidden />
            {c.label}
        </span>
    );
}
