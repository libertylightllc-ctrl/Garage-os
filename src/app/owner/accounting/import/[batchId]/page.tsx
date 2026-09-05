import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import {
    commitLedgerImportBatchAction,
    discardLedgerImportBatchAction,
} from "@/app/actions/import";

export const dynamic = "force-dynamic";

/**
 * Import batch preview + commit page — E7b step 4 (AR 2026-09-03).
 *
 * Renders the DRAFT batch's preview summary + parse errors, plus
 * Commit + Discard affordances. After commit, shows the outcome
 * (committed / skipped / failed counts from URL params) + the
 * per-row error list from LedgerImportError.
 *
 * Owner-only. See rule 17 for the two-phase discipline.
 */
export default async function ImportBatchPage({
    params,
    searchParams,
}: {
    params: Promise<{ batchId: string }>;
    searchParams: Promise<{ committed?: string; skipped?: string; failed?: string; error?: string }>;
}) {
    const session = await requireRole("OWNER");
    const { batchId } = await params;
    const { committed, skipped, failed, error } = await searchParams;

    const batch = await prisma.ledgerImportBatch.findFirst({
        where: { id: batchId, garageId: session.user.garageId },
        include: {
            uploadedBy: { select: { name: true } },
            committedBy: { select: { name: true } },
            errors: { orderBy: { rowIndex: "asc" } },
        },
    });
    if (!batch) notFound();

    const summary = batch.previewSummaryJson as unknown as {
        totalRows: number;
        willCreate: number;
        willSkip: number;
        willFail: number;
        parseErrors: { rowIndex: number; reason: string }[];
    };

    const KIND_LABEL: Record<string, string> = {
        CUSTOMER: "Customers",
        VENDOR: "Vendors",
        ITEM: "Items",
        OPENING_BALANCE: "Opening balances (A/R)",
    };

    return (
        <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
            <AppNav role="OWNER" active="accounting" />

            <div>
                <div className="text-xs text-text-mute">
                    <Link href="/owner/accounting" className="hover:underline">
                        Accounting
                    </Link>
                    {" › "}
                    <Link href="/owner/accounting/import" className="hover:underline">
                        Import
                    </Link>
                    {" › "}
                    {batch.fileName}
                </div>
                <h1 className="mt-1 flex flex-wrap items-baseline gap-3 text-2xl font-semibold tracking-tight">
                    {KIND_LABEL[batch.kind] ?? batch.kind}
                    <span
                        className={`text-sm font-medium ${
                            batch.status === "COMMITTED"
                                ? "text-emerald-700 dark:text-emerald-400"
                                : batch.status === "DISCARDED"
                                    ? "text-text-mute"
                                    : "text-warning-700 dark:text-warning-500"
                        }`}
                    >
                        {batch.status === "COMMITTED"
                            ? "Committed"
                            : batch.status === "DISCARDED"
                                ? "Discarded"
                                : "Draft — awaiting review"}
                    </span>
                </h1>
                <div className="mt-1 text-xs text-text-mute">
                    Uploaded by {batch.uploadedBy.name} · file <span className="font-medium">{batch.fileName}</span>
                    {batch.committedAt && batch.committedBy ? (
                        <>
                            {" "}
                            · committed by {batch.committedBy.name} at{" "}
                            {batch.committedAt.toISOString().slice(0, 16).replace("T", " ")}
                        </>
                    ) : null}
                </div>
            </div>

            {error ? (
                <div className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
                    {error}
                </div>
            ) : null}

            {/* Post-commit outcome — shown when the redirect landed with counts */}
            {committed !== undefined || skipped !== undefined || failed !== undefined ? (
                <div className="rounded-xl border border-emerald-500/40 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-500">
                    <div className="font-semibold">
                        Committed {committed ?? 0} · skipped {skipped ?? 0} · failed {failed ?? 0}
                    </div>
                    {Number(failed ?? 0) > 0 ? (
                        <div className="mt-1 text-xs">
                            See the failed-row list below for reasons.
                        </div>
                    ) : null}
                </div>
            ) : null}

            {/* Preview summary — always shown, regardless of status */}
            <section className="rounded-xl border border-border bg-surface p-4">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-mute">
                    Preview summary
                </h2>
                <div className="grid grid-cols-3 gap-3 text-sm">
                    <SummaryCell label="Would create" value={summary.willCreate} tone="ok" />
                    <SummaryCell label="Would skip" value={summary.willSkip} tone="mute" />
                    <SummaryCell label="Would fail" value={summary.willFail} tone={summary.willFail > 0 ? "warn" : "mute"} />
                </div>
                <p className="mt-2 text-xs text-text-mute">
                    Total parsed rows: {summary.totalRows}. Match-time outcomes are recomputed on
                    commit — a customer/vendor/part added between preview and commit changes
                    &quot;fail&quot; to &quot;create&quot;.
                </p>
            </section>

            {/* Parse errors — file-format issues surfaced by the parser */}
            {summary.parseErrors.length > 0 ? (
                <section className="rounded-xl border border-warning-500/40 bg-warning-50 p-4 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                    <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">
                        Parse errors ({summary.parseErrors.length})
                    </h2>
                    <ul className="space-y-1 text-xs">
                        {summary.parseErrors.slice(0, 20).map((e) => (
                            <li key={e.rowIndex}>
                                Row {e.rowIndex}: {e.reason}
                            </li>
                        ))}
                        {summary.parseErrors.length > 20 ? (
                            <li>… and {summary.parseErrors.length - 20} more.</li>
                        ) : null}
                    </ul>
                </section>
            ) : null}

            {/* Commit / Discard — only shown when still DRAFT */}
            {batch.status === "DRAFT" ? (
                <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4">
                    <div className="text-sm text-text-mute">
                        Ready? Commit writes the {summary.willCreate} new row(s). Skip and fail
                        rows are recorded but nothing else is written.
                    </div>
                    <div className="flex gap-2">
                        <form action={discardLedgerImportBatchAction}>
                            <input type="hidden" name="batchId" value={batch.id} />
                            <button
                                type="submit"
                                className="inline-flex h-9 items-center rounded-md border border-border bg-transparent px-3 text-sm font-medium hover:bg-surface-2"
                            >
                                Discard
                            </button>
                        </form>
                        <form action={commitLedgerImportBatchAction}>
                            <input type="hidden" name="batchId" value={batch.id} />
                            <button
                                type="submit"
                                className="inline-flex h-9 items-center rounded-md bg-brand-900 px-3 text-sm font-semibold text-white hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
                            >
                                Commit
                            </button>
                        </form>
                    </div>
                </section>
            ) : null}

            {/* Per-row errors from the commit — populated after commit runs */}
            {batch.errors.length > 0 ? (
                <section className="overflow-hidden rounded-xl border border-danger-500/40">
                    <div className="border-b border-danger-500/40 bg-danger-50 px-4 py-2 text-sm font-semibold text-danger-700 dark:bg-danger-500/10 dark:text-danger-500">
                        Rows that failed on commit ({batch.errors.length})
                    </div>
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-border/60 bg-surface-2/40 text-text-mute">
                                <th className="px-3 py-1.5 text-start">Row</th>
                                <th className="px-3 py-1.5 text-start">Reason</th>
                                <th className="px-3 py-1.5 text-start">Row content</th>
                            </tr>
                        </thead>
                        <tbody>
                            {batch.errors.map((e) => (
                                <tr key={e.id} className="border-b border-border/60 last:border-0">
                                    <td className="px-3 py-1.5 tabular-nums">{e.rowIndex}</td>
                                    <td className="px-3 py-1.5">{e.reason}</td>
                                    <td className="px-3 py-1.5 text-text-mute">
                                        <pre className="whitespace-pre-wrap font-mono text-[10px]">
                                            {JSON.stringify(e.rowJson, null, 0)}
                                        </pre>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            ) : null}
        </main>
    );
}

function SummaryCell({
    label,
    value,
    tone,
}: {
    label: string;
    value: number;
    tone: "ok" | "warn" | "mute";
}) {
    const toneClass =
        tone === "ok"
            ? "text-emerald-700 dark:text-emerald-400"
            : tone === "warn"
                ? "text-warning-700 dark:text-warning-500"
                : "text-text-mute";
    return (
        <div className="rounded-lg border border-border/60 bg-surface-2/30 p-3">
            <div className="text-xs uppercase tracking-wide text-text-mute">{label}</div>
            <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
        </div>
    );
}
