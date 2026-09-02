import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { PrintButton } from "@/components/print-button";
import { voidExpenseAction } from "@/app/actions/expenses";

export const dynamic = "force-dynamic";

// Accounting E1d — expense detail (AR 2026-09-02). Shows the row,
// the ledger pairs it posted, and a Void affordance while ACTIVE.

const money = (n: number) => `AED ${n.toFixed(2)}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

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

export default async function ExpenseDetailPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ error?: string }>;
}) {
    const session = await requireAnyRole(["OWNER", "MASTER"]);
    const { id } = await params;
    const { error } = await searchParams;

    const expense = await prisma.expense.findFirst({
        where: { id, garageId: session.user.garageId },
        include: { supplier: { select: { id: true, name: true } } },
    });
    if (!expense) notFound();

    // All ledger rows for this expense — record pair + void pair
    // (if voided). Ordered by createdAt so the record pair renders
    // first, void pair (if any) below it.
    const ledgerRows = await prisma.ledgerEntry.findMany({
        where: { sourceType: "EXPENSE", sourceId: expense.id },
        orderBy: { createdAt: "asc" },
    });

    // Net per account across all rows for this expense — should be
    // zero on every account when voided. Rendered as a sanity check
    // the operator can eyeball.
    const netByAccount = new Map<string, number>();
    for (const r of ledgerRows) {
        const net = Number(r.debit) - Number(r.credit);
        netByAccount.set(r.account, (netByAccount.get(r.account) ?? 0) + net);
    }

    const isActive = expense.status === "ACTIVE";

    const todayIso = isoDate(new Date());

    return (
        <main
            data-print-document="expense-record"
            className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6 print:max-w-none print:p-0"
        >
            <div className="print:hidden">
                <AppNav role={session.user.role as "OWNER" | "MASTER"} active="accounting" />
            </div>

            <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                    <div className="text-xs text-text-mute print:hidden">
                        <Link href="/owner/accounting" className="hover:underline">Accounting</Link>
                        {" › "}
                        <Link href="/owner/accounting/expenses" className="hover:underline">Expenses</Link>
                        {" › "}
                        {CATEGORY_LABEL[expense.category] ?? expense.category}
                    </div>
                    <h1 className="mt-1 flex flex-wrap items-baseline gap-3 text-2xl font-semibold tracking-tight">
                        {CATEGORY_LABEL[expense.category] ?? expense.category}
                        <span
                            className={`text-sm font-medium ${isActive ? "text-emerald-700 dark:text-emerald-400" : "text-text-mute"}`}
                        >
                            {isActive ? "Active" : "Void"}
                        </span>
                        <span className="ms-1 hidden text-base font-normal text-text-mute print:inline">
                            — Expense Record
                        </span>
                    </h1>
                    <div className="mt-1 hidden text-xs text-text-mute print:block">
                        Generated {todayIso}
                    </div>
                </div>
                <PrintButton className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-sm font-medium hover:bg-surface-2 print:hidden">
                    🖨 Print
                </PrintButton>
            </div>

            {error ? (
                <div className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500 print:hidden">
                    {error}
                </div>
            ) : null}

            {/* Header facts. Total (gross) is the load-bearing
                money — that's what the shop actually paid. Net + VAT
                render only when there's a VAT split to explain
                (pre-E1f rows post as gross-with-zero-VAT and read
                back as total==subtotal, vatAmount==0). */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Fact label="Amount paid" value={money(Number(expense.total))} />
                <Fact label="Date" value={isoDate(expense.paidAt)} />
                <Fact label="Method" value={expense.method} />
                <Fact label="Supplier" value={expense.supplier?.name ?? "—"} />
            </div>
            {Number(expense.vatAmount) > 0 ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
                    <Fact label="Net (posts to expense)" value={money(Number(expense.subtotal))} />
                    <Fact label="VAT (reclaimable)" value={money(Number(expense.vatAmount))} />
                </div>
            ) : null}

            {expense.note ? (
                <div className="rounded-xl border border-border bg-surface p-4 text-sm">
                    <div className="text-xs uppercase tracking-wide text-text-mute">Note</div>
                    <div className="mt-1">{expense.note}</div>
                </div>
            ) : null}

            {expense.attachmentUrl ? (
                <div className="rounded-xl border border-border bg-surface p-4 text-sm">
                    <div className="text-xs uppercase tracking-wide text-text-mute">Attachment</div>
                    <a
                        href={expense.attachmentUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block break-all hover:underline"
                    >
                        {expense.attachmentUrl}
                    </a>
                </div>
            ) : null}

            {/* Ledger rows */}
            <div className="overflow-hidden rounded-xl border border-border">
                <div className="border-b border-border bg-surface-2/40 px-3 py-2 text-xs uppercase tracking-wide text-text-mute">
                    Ledger entries ({ledgerRows.length})
                </div>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-border text-xs uppercase tracking-wide text-text-mute">
                            <th className="px-3 py-2 text-start font-semibold">Account</th>
                            <th className="px-3 py-2 text-end font-semibold">Debit</th>
                            <th className="px-3 py-2 text-end font-semibold">Credit</th>
                            <th className="px-3 py-2 text-end font-semibold">When</th>
                        </tr>
                    </thead>
                    <tbody>
                        {ledgerRows.map((r) => (
                            <tr key={r.id} className="border-b border-border/60 last:border-0">
                                <td className="px-3 py-2">{r.account}</td>
                                <td className="px-3 py-2 text-end tabular-nums">
                                    {Number(r.debit) > 0 ? money(Number(r.debit)) : ""}
                                </td>
                                <td className="px-3 py-2 text-end tabular-nums">
                                    {Number(r.credit) > 0 ? money(Number(r.credit)) : ""}
                                </td>
                                <td className="px-3 py-2 text-end tabular-nums text-xs text-text-mute">
                                    {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}Z
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {/* Net-per-account footer — for a voided expense this
                    reads all zeros, which is what the operator wants
                    to see ("the reversal netted"). */}
                {!isActive ? (
                    <div className="border-t border-border bg-surface-2/40 px-3 py-2 text-xs">
                        <div className="text-text-mute">Net per account (record + void):</div>
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                            {Array.from(netByAccount.entries()).map(([acc, net]) => (
                                <span key={acc}>
                                    <span className="text-text-mute">{acc}:</span>{" "}
                                    <span
                                        className={`tabular-nums font-medium ${Math.abs(net) < 0.005 ? "text-emerald-700 dark:text-emerald-400" : "text-danger-700 dark:text-danger-500"}`}
                                    >
                                        {money(Math.abs(net))}
                                        {Math.abs(net) < 0.005 ? " ✓" : ""}
                                    </span>
                                </span>
                            ))}
                        </div>
                    </div>
                ) : null}
            </div>

            {/* Void affordance — only while ACTIVE. Hidden on print
                — the printable record is a reference document, not
                an input surface. */}
            {isActive ? (
                <form
                    action={voidExpenseAction}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 print:hidden"
                >
                    <input type="hidden" name="expenseId" value={expense.id} />
                    <div className="text-sm text-text-mute">
                        Made a mistake? Void this expense to post a reversing pair. The record pair stays for audit — the two net to zero across every account.
                    </div>
                    <button
                        type="submit"
                        className="inline-flex items-center rounded-md border border-danger-500/40 bg-danger-50 px-3 py-1.5 text-sm font-medium text-danger-700 hover:bg-danger-100 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500"
                    >
                        Void expense
                    </button>
                </form>
            ) : null}
        </main>
    );
}

function Fact({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-xl border border-border bg-surface p-3">
            <div className="text-xs text-text-mute">{label}</div>
            <div className="mt-1 text-sm font-medium tabular-nums">{value}</div>
        </div>
    );
}
