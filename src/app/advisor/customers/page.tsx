import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Customers list + search (AR 2026-08-25, Batch B).
 *
 * Nav landing for the Customers entry added this batch. Two purposes:
 *   1. Find a customer by name / phone / TRN — used constantly by
 *      the cashier chasing a payment.
 *   2. Direct link from each row to the customer's printable
 *      statement (`/advisor/customers/[id]/statement`).
 *
 * Guard: ADVISOR + OWNER + MASTER + CASHIER (cashier's job is to
 * get money in; they need this surface). Garage-scoped via WHERE
 * garageId = session.user.garageId.
 *
 * Read-only. No writes.
 */
export default async function CustomersListPage({
    searchParams,
}: {
    searchParams: Promise<{ q?: string }>;
}) {
    const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER", "CASHIER"]);
    const sp = await searchParams;
    const t = await getT();

    const q = (sp.q ?? "").trim();
    // No query → show the 50 most-recently-updated customers so the
    // page is useful with zero typing (cashier's first move is
    // usually "the customer I was just talking to"). With a query,
    // filter by contains on name / phone / trn (case-insensitive
    // where the DB supports it — Postgres does).
    const customers = await prisma.customer.findMany({
        where: {
            garageId: session.user.garageId,
            ...(q
                ? {
                      OR: [
                          { name: { contains: q, mode: "insensitive" as const } },
                          { phone: { contains: q } },
                          { trn: { contains: q } },
                      ],
                  }
                : {}),
        },
        select: {
            id: true, name: true, phone: true, trn: true, phoneNeedsReview: true,
            _count: { select: { vehicles: true } },
        },
        orderBy: q ? { name: "asc" } : { updatedAt: "desc" },
        take: q ? 200 : 50,
    });

    return (
        <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-4 pb-24">
            <AppNav role="ADVISOR" active="customers" />
            <h1 className="mt-2 text-xl font-semibold">{t("customersListHeading")}</h1>

            <form method="GET" className="flex items-end gap-2">
                <label className="flex-1">
                    <span className="block text-xs text-text-mute">
                        {t("customersSearchLabel")}
                    </span>
                    <input
                        type="search"
                        name="q"
                        defaultValue={q}
                        placeholder={t("customersSearchPlaceholder")}
                        className="mt-1 w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
                    />
                </label>
                <button
                    type="submit"
                    className="inline-flex h-10 items-center justify-center rounded-lg bg-brand-900 px-4 text-sm font-semibold text-white hover:bg-brand-700 dark:bg-white dark:text-brand-900"
                >
                    {t("customersSearchGo")}
                </button>
            </form>

            {customers.length === 0 ? (
                <p className="rounded-lg border border-border bg-surface-2 p-4 text-center text-sm text-text-mute">
                    {q ? t("customersNoMatch") : t("customersEmptyHint")}
                </p>
            ) : (
                <>
                    {!q ? (
                        <p className="text-xs text-text-mute">
                            {t("customersRecentPrefix")}
                        </p>
                    ) : null}
                    <ul className="flex flex-col gap-2">
                        {customers.map((c) => (
                            <li
                                key={c.id}
                                className="rounded-lg border border-border bg-surface-2 p-3"
                            >
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="min-w-0">
                                        <div className="truncate font-semibold">
                                            {c.name}
                                            {c.phoneNeedsReview ? (
                                                <span className="ml-2 text-[10px] text-warning-700 dark:text-warning-500">
                                                    †
                                                </span>
                                            ) : null}
                                        </div>
                                        <div className="text-xs font-mono tabular-nums text-text-mute">
                                            {c.phone}
                                            {c.trn ? <span className="ml-3">TRN {c.trn}</span> : null}
                                        </div>
                                        <div className="mt-0.5 text-[11px] text-text-mute">
                                            {c._count.vehicles} {c._count.vehicles === 1 ? t("customersVehicleSingular") : t("customersVehiclePlural")}
                                        </div>
                                    </div>
                                    <div className="flex gap-2">
                                        <Link
                                            href={`/advisor/customers/${c.id}`}
                                            className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-xs font-semibold hover:bg-surface"
                                        >
                                            {t("customersOpenCta")}
                                        </Link>
                                        <Link
                                            href={`/advisor/customers/${c.id}/statement`}
                                            className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-xs font-semibold hover:bg-surface-2"
                                        >
                                            📄 {t("statementShortLink")}
                                        </Link>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                    {!q && customers.length === 50 ? (
                        <p className="text-[11px] text-text-mute">
                            {t("customersRecentTruncated")}
                        </p>
                    ) : null}
                </>
            )}
        </main>
    );
}
