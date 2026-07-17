import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import { createSupplierAction } from "@/app/actions/suppliers";
import { Paginator } from "@/components/paginator";
import { PER_PAGE_OPTIONS, computeWindow } from "@/lib/pagination";

export const dynamic = "force-dynamic";

// Cap on the "Removed" (soft-deleted) section. Kept as a historical
// breadcrumb so old references still resolve; NOT a working list, so it
// gets a hard ceiling + a "showing first N of M" caption rather than its
// own paginator. If a shop ever crosses this cap, the truncation is
// loud, not silent.
const INACTIVE_CAP = 50;

// Inventory 1c — supplier directory: add + list. OWNER-only, garage-scoped.
// Reads/creates Supplier rows only; does NOT touch the job / estimate /
// part-request flow. Deactivated suppliers are shown in a separate muted
// section so historical references stay discoverable without cluttering
// the active list.
export default async function OwnerSuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; page?: string; per?: string }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const { error, page: rawPage, per: rawPer } = await searchParams;
  const garageId = session.user.garageId;

  // Active suppliers — paginated. Count first so the paginator can clamp
  // ?page / ?per to a valid window before we fetch a slice.
  const activeWhere = { garageId, active: true } as const;
  const activeTotal = await prisma.supplier.count({ where: activeWhere });
  const activeWindow = computeWindow({
    rawPage,
    rawPer,
    totalCount: activeTotal,
  });
  const active = await prisma.supplier.findMany({
    where: activeWhere,
    orderBy: [{ name: "asc" }],
    skip: activeWindow.skip,
    take: activeWindow.take,
    include: { _count: { select: { parts: true } } },
  });

  // Inactive suppliers — the archive. Hard cap at INACTIVE_CAP; if a
  // shop ever crosses it, the caption says so instead of silently hiding
  // rows. The count query is O(index) so cheap either way.
  const inactiveWhere = { garageId, active: false } as const;
  const inactiveTotal = await prisma.supplier.count({ where: inactiveWhere });
  const inactive = await prisma.supplier.findMany({
    where: inactiveWhere,
    orderBy: [{ name: "asc" }],
    take: INACTIVE_CAP,
    include: { _count: { select: { parts: true } } },
  });

  return (
    <div>
      <AppNav role="OWNER" active="suppliers" />
      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("suppliersTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("suppliersSubtitle")}</p>
        </header>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {/* Add-supplier form */}
        <form
          action={createSupplierAction}
          className="grid grid-cols-2 gap-3 rounded-xl border border-border p-4 sm:grid-cols-3"
        >
          <Field name="name" label={t("supplierName")} required className="col-span-2 sm:col-span-1" />
          <Field name="contactPerson" label={t("supplierContact")} />
          <Field name="phone" label={t("supplierPhone")} type="tel" />
          <Field name="email" label={t("supplierEmail")} type="email" />
          <Field name="trn" label={t("supplierTrn")} />
          <Field name="address" label={t("supplierAddress")} className="col-span-2 sm:col-span-3" />
          <div className="col-span-2 flex items-end sm:col-span-3">
            <Button type="submit">{t("saveSupplier")}</Button>
          </div>
        </form>

        {/* Active suppliers */}
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t("supplierName")}</th>
                <th className="px-4 py-3">{t("supplierContact")}</th>
                <th className="px-4 py-3">{t("supplierPhone")}</th>
                <th className="px-4 py-3 text-right">{t("supplierParts")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {active.map((s) => (
                <tr key={s.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/owner/suppliers/${s.id}`} className="hover:underline">
                      {s.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{s.contactPerson ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.phone ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {s._count.parts}
                  </td>
                </tr>
              ))}
              {active.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">
                    {t("noSuppliersYet")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {activeTotal > 0 ? (
          <Paginator
            currentPath="/owner/suppliers"
            currentSearchParams=""
            page={activeWindow.page}
            perPage={activeWindow.perPage}
            pageCount={activeWindow.pageCount}
            from={activeWindow.from}
            to={activeWindow.to}
            total={activeWindow.totalCount}
            perPageOptions={PER_PAGE_OPTIONS}
            labels={{
              showing: t("paginationShowing"),
              rowsPerPage: t("paginationRowsPerPage"),
              prev: t("paginationPrev"),
              next: t("paginationNext"),
            }}
          />
        ) : null}

        {/* Deactivated suppliers — kept for history, muted. Hard-capped
            at INACTIVE_CAP; caption is louder than silent truncation. */}
        {inactive.length > 0 ? (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("suppliersInactive")}
            </h2>
            <div className="overflow-hidden rounded-xl border border-dashed border-border">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  {inactive.map((s) => (
                    <tr key={s.id} className="text-muted-foreground">
                      <td className="px-4 py-2.5">
                        <Link href={`/owner/suppliers/${s.id}`} className="hover:underline">
                          {s.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {s._count.parts} {t("supplierParts").toLowerCase()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {inactiveTotal > INACTIVE_CAP ? (
              <p className="text-xs text-muted-foreground">
                {t("suppliersInactiveCap")
                  .replace("{shown}", String(INACTIVE_CAP))
                  .replace("{total}", String(inactiveTotal))}
              </p>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

function Field({
  label,
  className,
  ...input
}: {
  label: string;
  className?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <input
        {...input}
        className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
      />
    </label>
  );
}
