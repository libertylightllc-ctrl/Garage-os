import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { recordExpenseAction } from "@/app/actions/expenses";
import { ExpenseAmountFields } from "./ExpenseAmountFields";

export const dynamic = "force-dynamic";

// Accounting E1d — expenses list + record form (AR 2026-09-02).
// OWNER + MASTER. Direct-posting flow — the form submits to
// recordExpenseAction which creates the Expense row and posts one
// balanced ledger pair inside the same tx.

const money = (n: number) => `AED ${n.toFixed(2)}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// Category labels (kept alongside enum values — the enum names
// like REPAIRS_MAINT are DB-facing, not for the operator to read).
const CATEGORY_LABEL: Record<string, string> = {
    RENT: "Rent",
    SALARIES: "Salaries & Wages",
    UTILITIES: "Utilities",
    TOOLS: "Tools & Equipment",
    VEHICLE: "Motor Vehicle",
    MARKETING: "Marketing",
    BANK_CHARGES: "Bank Charges",
    OFFICE: "Office Supplies",
    REPAIRS_MAINT: "Repairs & Maintenance",
    PROF_FEES: "Professional Fees",
    MISC: "Miscellaneous",
};
const CATEGORIES = Object.keys(CATEGORY_LABEL);
const METHODS = ["Cash", "Bank Transfer", "Card", "Cheque", "Other"];

export default async function ExpensesListPage({
    searchParams,
}: {
    searchParams: Promise<{ error?: string }>;
}) {
    const session = await requireAnyRole(["OWNER", "MASTER"]);
    const { error } = await searchParams;
    const garageId = session.user.garageId;

    // Recent 50 expenses, newest first. If a real shop grows past
    // this, pagination lands as a follow-up — same pattern as other
    // owner lists in the app.
    const expenses = await prisma.expense.findMany({
        where: { garageId },
        orderBy: { paidAt: "desc" },
        take: 50,
        include: { supplier: { select: { name: true } } },
    });

    // Suppliers for the record form's optional link. Active only.
    const suppliers = await prisma.supplier.findMany({
        where: { garageId, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
    });

    // Month-to-date totals per category — quick sanity band on top,
    // "here's what you spent this month by category." Simple sum
    // over ACTIVE rows in the current calendar month.
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthExpenses = expenses.filter(
        (e) => e.status === "ACTIVE" && e.paidAt >= monthStart,
    );
    const monthTotalByCategory = new Map<string, number>();
    let monthTotal = 0;
    for (const e of monthExpenses) {
        // MTD tile still sums the total (gross) — that's what
        // "money spent this month" means to the operator, not the
        // net that lands on the P&L. E1f split affects the ledger
        // + P&L, not this operator-facing sanity band.
        const amt = Number(e.total);
        monthTotalByCategory.set(e.category, (monthTotalByCategory.get(e.category) ?? 0) + amt);
        monthTotal += amt;
    }
    const topCategories = Array.from(monthTotalByCategory.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

    const todayIso = isoDate(now);

    return (
        <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
            <AppNav role={session.user.role as "OWNER" | "MASTER"} active="accounting" />

            <div>
                <div className="text-xs text-text-mute">
                    <Link href="/owner/accounting" className="hover:underline">Accounting</Link>
                    {" › "}
                    Expenses
                </div>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">Expenses</h1>
                <p className="mt-1 text-sm text-text-mute">
                    Money spent that isn&apos;t parts. Rent, salaries, utilities, and everything else that shows up on the profit and loss.
                </p>
            </div>

            {error ? (
                <div className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
                    {error}
                </div>
            ) : null}

            {/* Month-to-date band — always rendered, even when the
                total is zero. AR 2026-09-02: an owner who records an
                expense, voids it, and watches the tile disappear
                will wonder whether the page broke. Showing AED 0.00
                is the honest feedback. The inner top-categories list
                stays gated (nothing to list = don't render the list
                — that's an absence-is-honest case). */}
            <div className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-baseline justify-between gap-3">
                    <div className="text-xs uppercase tracking-wide text-text-mute">
                        This month
                    </div>
                    <div className="text-xl font-semibold tabular-nums">{money(monthTotal)}</div>
                </div>
                {topCategories.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-mute">
                        {topCategories.map(([cat, amt]) => (
                            <span key={cat}>
                                {CATEGORY_LABEL[cat] ?? cat}:{" "}
                                <span className="tabular-nums font-medium text-text">{money(amt)}</span>
                            </span>
                        ))}
                    </div>
                ) : null}
            </div>

            {/* Record form. Server-action submit — no client component
                needed. Category + method + date are the required
                shape; supplier / note / attachment are optional. */}
            <form
                action={recordExpenseAction}
                className="space-y-3 rounded-xl border border-border bg-surface p-4"
            >
                <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-base font-semibold">Record an expense</h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Category</span>
                        <select
                            name="category"
                            required
                            defaultValue=""
                            className="rounded-md border border-border bg-transparent px-2 py-1.5"
                        >
                            <option value="" disabled>
                                Pick a category…
                            </option>
                            {CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                    {CATEGORY_LABEL[c]}
                                </option>
                            ))}
                        </select>
                    </label>
                    <ExpenseAmountFields />
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Payment method</span>
                        <select
                            name="method"
                            required
                            defaultValue="Cash"
                            className="rounded-md border border-border bg-transparent px-2 py-1.5"
                        >
                            {METHODS.map((m) => (
                                <option key={m} value={m}>
                                    {m}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Date</span>
                        <input
                            name="paidAt"
                            type="date"
                            defaultValue={todayIso}
                            className="rounded-md border border-border bg-transparent px-2 py-1.5 tabular-nums"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                        <span className="font-medium">
                            Supplier <span className="text-xs font-normal text-text-mute">(optional)</span>
                        </span>
                        <select
                            name="supplierId"
                            defaultValue=""
                            className="rounded-md border border-border bg-transparent px-2 py-1.5"
                        >
                            <option value="">— none —</option>
                            {suppliers.map((s) => (
                                <option key={s.id} value={s.id}>
                                    {s.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                        <span className="font-medium">
                            Note <span className="text-xs font-normal text-text-mute">(optional)</span>
                        </span>
                        <input
                            name="note"
                            type="text"
                            maxLength={200}
                            placeholder="e.g. September rent, DEWA electricity bill"
                            className="rounded-md border border-border bg-transparent px-2 py-1.5"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                        <span className="font-medium">
                            Attachment URL <span className="text-xs font-normal text-text-mute">(optional)</span>
                        </span>
                        <input
                            name="attachmentUrl"
                            type="url"
                            placeholder="Paste a link to the receipt (upload UI ships in a follow-up)"
                            className="rounded-md border border-border bg-transparent px-2 py-1.5"
                        />
                    </label>
                </div>
                <div className="flex justify-end">
                    <button
                        type="submit"
                        className="inline-flex items-center rounded-lg bg-brand-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
                    >
                        Record expense
                    </button>
                </div>
            </form>

            {/* History table */}
            <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-wide text-text-mute">
                            <th className="px-3 py-2 text-start font-semibold">Date</th>
                            <th className="px-3 py-2 text-start font-semibold">Category</th>
                            <th className="px-3 py-2 text-start font-semibold">Note</th>
                            <th className="px-3 py-2 text-end font-semibold">Amount</th>
                            <th className="px-3 py-2 text-end font-semibold">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {expenses.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-3 py-6 text-center text-sm text-text-mute">
                                    No expenses recorded yet. Use the form above to record your first.
                                </td>
                            </tr>
                        ) : (
                            expenses.map((e) => (
                                <tr key={e.id} className="border-b border-border/60 last:border-0 hover:bg-surface-2/30">
                                    <td className="px-3 py-2 tabular-nums text-text-mute">
                                        {isoDate(e.paidAt)}
                                    </td>
                                    <td className="px-3 py-2 font-medium">
                                        <Link href={`/owner/accounting/expenses/${e.id}`} className="hover:underline">
                                            {CATEGORY_LABEL[e.category] ?? e.category}
                                        </Link>
                                        {e.supplier ? (
                                            <span className="ms-2 text-xs text-text-mute">
                                                · {e.supplier.name}
                                            </span>
                                        ) : null}
                                    </td>
                                    <td className="px-3 py-2 text-text-mute">
                                        <span className="line-clamp-1">{e.note ?? ""}</span>
                                    </td>
                                    <td
                                        className={`px-3 py-2 text-end tabular-nums font-medium ${e.status === "VOID" ? "text-text-mute line-through" : ""}`}
                                    >
                                        {money(Number(e.total))}
                                        {Number(e.vatAmount) > 0 ? (
                                            <div className="text-xs font-normal text-text-mute">
                                                incl. VAT {money(Number(e.vatAmount))}
                                            </div>
                                        ) : null}
                                    </td>
                                    <td className="px-3 py-2 text-end text-xs">
                                        {e.status === "VOID" ? (
                                            <span className="text-text-mute">Void</span>
                                        ) : (
                                            <span className="text-emerald-700 dark:text-emerald-400">Active</span>
                                        )}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </main>
    );
}
