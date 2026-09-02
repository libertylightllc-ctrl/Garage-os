import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";

export const dynamic = "force-dynamic";

/**
 * Accounting hub — E1a0 (AR 2026-08-30).
 *
 * Landing page for the accounting section. Routes what used to be
 * top-level owner pages (Payables, Accounting export) under one
 * roof, ready to grow with Expenses (E1d), P&L (E3), VAT (E4),
 * and Trial Balance (E5) as they land.
 *
 * OWNER + MASTER on the hub itself. Individual children keep their
 * own guards — the Export card is only visible to OWNER because
 * the CSV export contains the entire financial position and stays
 * OWNER-only per CLAUDE.md financial-reporting rule.
 */
export default async function AccountingHubPage() {
    const session = await requireAnyRole(["OWNER", "MASTER"]);
    const role = session.user.role as "OWNER" | "MASTER";
    const isOwner = role === "OWNER";

    interface Tile {
        href: string;
        title: string;
        blurb: string;
        visibleTo: "OWNER_ONLY" | "OWNER_MASTER";
        icon: string; // emoji glyph, cheap + theme-safe
    }
    const tiles: Tile[] = [
        {
            href: "/owner/payables",
            title: "Payables",
            blurb: "What you owe suppliers. Bills, payments, statements, aging.",
            visibleTo: "OWNER_MASTER",
            icon: "🪙",
        },
        {
            href: "/owner/accounting/expenses",
            title: "Expenses",
            blurb: "Money spent that isn't parts. Rent, salaries, utilities, tools, and everything else that shows up on the P&L.",
            visibleTo: "OWNER_MASTER",
            icon: "🧾",
        },
        {
            href: "/owner/accounting/export",
            title: "CSV export",
            blurb: "Download journal, invoices, payments, customers, chart-of-accounts for your accountant.",
            visibleTo: "OWNER_ONLY",
            icon: "📤",
        },
        // E3 → P&L. E4 → VAT summary. E5 → Trial balance + balance sheet.
        // Each lands as its own tile in the display order accountants
        // read them: operational (Payables, Expenses) → periodic reports
        // (P&L, VAT) → proofs (TB, BS) → export.
    ];

    const visible = tiles.filter((t) => t.visibleTo === "OWNER_MASTER" || isOwner);

    return (
        <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
            <AppNav role={role} active="accounting" />
            <div>
                <h1 className="text-2xl font-semibold tracking-tight">Accounting</h1>
                <p className="mt-1 text-sm text-text-mute">
                    Your books in one place. Growing with the phase — Expenses, P&amp;L, VAT and
                    trial balance land here as they ship.
                </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {visible.map((tile) => (
                    <Link
                        key={tile.href}
                        href={tile.href}
                        className="group flex flex-col gap-2 rounded-xl border border-border bg-surface p-5 shadow-sm transition hover:border-border-strong hover:bg-surface-2"
                    >
                        <div className="flex items-baseline gap-2">
                            <span className="text-2xl" aria-hidden="true">
                                {tile.icon}
                            </span>
                            <span className="text-base font-semibold">{tile.title}</span>
                        </div>
                        <p className="text-sm text-text-mute">{tile.blurb}</p>
                        <span className="mt-auto text-xs text-text-mute group-hover:text-text">
                            Open →
                        </span>
                    </Link>
                ))}
            </div>
        </main>
    );
}
