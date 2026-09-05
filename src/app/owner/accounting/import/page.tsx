import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import {
    previewCustomerImportAction,
    previewVendorImportAction,
    previewItemImportAction,
    previewOpeningBalanceImportAction,
} from "@/app/actions/import";

export const dynamic = "force-dynamic";

/**
 * QuickBooks-migration import hub — E7b (AR 2026-09-03).
 *
 * Four upload sections (Customer / Vendor / Item / Opening Balance)
 * each pointing at its preview action. History of past batches
 * below. Every upload lands on the preview page ([batchId]) as a
 * DRAFT batch — never writes on upload. See rule 17.
 *
 * Owner-only. Financial reporting + bulk-write bucket — same tier
 * as ledger / statements / vat.
 */
export default async function ImportHubPage({
    searchParams,
}: {
    searchParams: Promise<{ error?: string; discarded?: string }>;
}) {
    const session = await requireRole("OWNER");
    const { error, discarded } = await searchParams;

    const batches = await prisma.ledgerImportBatch.findMany({
        where: { garageId: session.user.garageId },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
            id: true,
            kind: true,
            status: true,
            fileName: true,
            createdAt: true,
            committedAt: true,
            uploadedBy: { select: { name: true } },
            _count: { select: { errors: true } },
        },
    });

    const KIND_LABEL: Record<string, string> = {
        CUSTOMER: "Customers",
        VENDOR: "Vendors",
        ITEM: "Items",
        OPENING_BALANCE: "Opening balances (A/R)",
    };
    const STATUS_LABEL: Record<string, string> = {
        DRAFT: "Draft (preview)",
        COMMITTED: "Committed",
        DISCARDED: "Discarded",
    };

    return (
        <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
            <AppNav role="OWNER" active="accounting" />

            <div>
                <div className="text-xs text-text-mute">
                    <Link href="/owner/accounting" className="hover:underline">
                        Accounting
                    </Link>{" "}
                    · Import
                </div>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">Import from QuickBooks</h1>
                <p className="mt-1 max-w-2xl text-sm text-text-mute">
                    Upload a CSV. Every upload previews first — nothing lands until you review
                    the numbers and confirm. Existing rows (matched by phone for customers, name
                    for vendors, SKU for items) are skipped, never overwritten.
                </p>
            </div>

            {error ? (
                <div className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
                    {error}
                </div>
            ) : null}
            {discarded === "1" ? (
                <div className="rounded-xl border border-border bg-surface-2/40 px-4 py-2.5 text-sm text-text-mute">
                    Preview discarded. Nothing was written.
                </div>
            ) : null}

            {/* Four uploads — grid of cards */}
            <div className="grid gap-3 sm:grid-cols-2">
                <UploadCard
                    title="Customers"
                    description={
                        <>
                            QuickBooks columns: <code>Customer, Phone</code> (required). Optional:{" "}
                            <code>Email, Address</code>. Dedupe on normalised phone.
                        </>
                    }
                    action={previewCustomerImportAction}
                />
                <UploadCard
                    title="Vendors"
                    description={
                        <>
                            Columns: <code>Vendor</code> (required). Optional:{" "}
                            <code>Phone, Email, TRN</code>. Dedupe on name (case-insensitive).
                        </>
                    }
                    action={previewVendorImportAction}
                />
                <UploadCard
                    title="Items"
                    description={
                        <>
                            Columns: <code>Item Name, SKU</code> (required). Optional:{" "}
                            <code>Sales Price, Purchase Cost</code>. Dedupe on SKU. Blank prices
                            default to 0.
                        </>
                    }
                    action={previewItemImportAction}
                />
                <UploadCard
                    title="Opening balances (A/R)"
                    description={
                        <>
                            Columns: <code>Customer, Balance, As of</code> (all required). Posts{" "}
                            DR AR / CR Opening Balance Equity per row. Customers must be
                            imported first — the OB import doesn&apos;t create customers.
                        </>
                    }
                    action={previewOpeningBalanceImportAction}
                    accent
                />
            </div>

            {/* Batch history */}
            <section>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-mute">
                    Recent uploads
                </h2>
                {batches.length === 0 ? (
                    <p className="text-sm text-text-mute">Nothing uploaded yet.</p>
                ) : (
                    <div className="overflow-hidden rounded-xl border border-border">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border bg-surface-2/40 text-xs uppercase tracking-wide text-text-mute">
                                    <th className="px-3 py-2 text-start font-semibold">File</th>
                                    <th className="px-3 py-2 text-start font-semibold">Kind</th>
                                    <th className="px-3 py-2 text-start font-semibold">Status</th>
                                    <th className="px-3 py-2 text-start font-semibold">Uploaded by</th>
                                    <th className="px-3 py-2 text-end font-semibold">Errors</th>
                                    <th className="px-3 py-2 text-end font-semibold">When</th>
                                </tr>
                            </thead>
                            <tbody>
                                {batches.map((b) => (
                                    <tr key={b.id} className="border-b border-border/60 last:border-0">
                                        <td className="px-3 py-2">
                                            <Link
                                                href={`/owner/accounting/import/${b.id}`}
                                                className="hover:underline"
                                            >
                                                {b.fileName}
                                            </Link>
                                        </td>
                                        <td className="px-3 py-2 text-xs">{KIND_LABEL[b.kind] ?? b.kind}</td>
                                        <td className="px-3 py-2 text-xs">
                                            <span
                                                className={
                                                    b.status === "COMMITTED"
                                                        ? "text-emerald-700 dark:text-emerald-400"
                                                        : b.status === "DISCARDED"
                                                            ? "text-text-mute"
                                                            : "text-warning-700 dark:text-warning-500"
                                                }
                                            >
                                                {STATUS_LABEL[b.status] ?? b.status}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2 text-xs text-text-mute">
                                            {b.uploadedBy.name}
                                        </td>
                                        <td className="px-3 py-2 text-end text-xs tabular-nums">
                                            {b._count.errors > 0 ? (
                                                <span className="text-danger-700 dark:text-danger-500">
                                                    {b._count.errors}
                                                </span>
                                            ) : (
                                                <span className="text-text-mute">0</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-end text-xs tabular-nums text-text-mute">
                                            {(b.committedAt ?? b.createdAt).toISOString().slice(0, 16).replace("T", " ")}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </main>
    );
}

function UploadCard({
    title,
    description,
    action,
    accent,
}: {
    title: string;
    description: React.ReactNode;
    action: (fd: FormData) => Promise<void>;
    accent?: boolean;
}) {
    return (
        <form
            action={action}
            encType="multipart/form-data"
            className={`flex flex-col gap-2 rounded-xl border p-4 ${accent ? "border-accent-500/40 bg-accent-500/5" : "border-border bg-surface"}`}
        >
            <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold">{title}</h3>
            </div>
            <p className="text-xs text-text-mute">{description}</p>
            <input
                type="file"
                name="file"
                accept=".csv,text/csv"
                required
                className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
            />
            <div className="flex justify-end">
                <button
                    type="submit"
                    className="inline-flex h-9 items-center rounded-lg bg-brand-900 px-3 text-sm font-semibold text-white hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
                >
                    Preview
                </button>
            </div>
        </form>
    );
}
