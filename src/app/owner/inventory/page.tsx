import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import { createPartAction } from "@/app/actions/inventory";
import { startPartsImportAction } from "@/app/actions/parts-import";
import { Paginator } from "@/components/paginator";
import { PER_PAGE_OPTIONS, computeWindow } from "@/lib/pagination";

export const dynamic = "force-dynamic";

// Inventory Phase 1, Slice 1 — parts catalog: add + list. OWNER-only,
// garage-scoped. Reads/creates catalog Part rows only; does NOT touch the
// job / estimate / part-request flow (that's Phase 3).
export default async function OwnerInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    imported?: string;
    skipped?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const { error, imported, skipped, page: rawPage, per: rawPer } = await searchParams;

  const partsWhere = {
    garageId: session.user.garageId,
    active: true,
  } as const;
  const totalCount = await prisma.part.count({ where: partsWhere });
  const partsWindow = computeWindow({ rawPage, rawPer, totalCount });
  const parts = await prisma.part.findMany({
    where: partsWhere,
    orderBy: [{ name: "asc" }],
    skip: partsWindow.skip,
    take: partsWindow.take,
    // `autoCreatedFromLineId` — non-null on Parts spun out of the
    // Estimate → PO auto-create review flow. Renders an "auto" chip
    // so the owner can spot rows that came from a free-text estimate
    // line (vs. hand-typed) and clean them up later if the shape's
    // wrong. See docs/Estimate-to-PO-Spec.md.
    select: {
      id: true,
      sku: true,
      name: true,
      cost: true,
      price: true,
      qtyOnHand: true,
      reorderLevel: true,
      autoCreatedFromLineId: true,
    },
  });
  const partsSearchParams = (() => {
    const p = new URLSearchParams();
    if (imported) p.set("imported", imported);
    if (skipped) p.set("skipped", skipped);
    return p.toString();
  })();

  const money = (v: unknown) =>
    new Intl.NumberFormat("en-AE", {
      style: "currency",
      currency: "AED",
      maximumFractionDigits: 2,
    }).format(Number(v));

  return (
    <div>
      <AppNav role="OWNER" active="inventory" />
      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("inventoryTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("inventorySubtitle")}</p>
        </header>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {imported ? (
          <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
            {imported === "1" ? t("importCreatedOne") : t("importCreated").replace("{n}", imported)}
            {skipped ? ` ${t("importSkipped").replace("{n}", skipped)}` : ""}
          </p>
        ) : null}

        {/* Import from invoice photo (OCR) */}
        <form
          action={startPartsImportAction}
          className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="space-y-0.5">
            <p className="text-sm font-medium">📷 {t("importFromPhoto")}</p>
            <p className="text-xs text-muted-foreground">{t("importFromPhotoHint")}</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="file"
              name="invoice"
              accept="image/png,image/jpeg,image/webp"
              required
              className="max-w-[220px] text-xs file:mr-2 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-xs"
            />
            <Button type="submit" variant="ghost">{t("importScan")}</Button>
          </div>
        </form>

        {/* Add-part form */}
        <form
          action={createPartAction}
          className="grid grid-cols-2 gap-3 rounded-xl border border-border p-4 sm:grid-cols-3 md:grid-cols-6"
        >
          <Field name="sku" label={t("partSku")} required />
          <Field name="name" label={t("partName")} required className="col-span-2" />
          <Field name="cost" label={t("partCost")} type="number" step="0.01" min="0" required />
          <Field name="price" label={t("partPrice")} type="number" step="0.01" min="0" required />
          <Field name="qtyOnHand" label={t("openingStock")} type="number" min="0" defaultValue="0" />
          <Field name="reorderLevel" label={t("partReorderLevel")} type="number" min="0" defaultValue="5" />
          <div className="col-span-2 flex items-end sm:col-span-3 md:col-span-6">
            <Button type="submit">{t("savePart")}</Button>
          </div>
        </form>

        {/* Parts list */}
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t("partSku")}</th>
                <th className="px-4 py-3">{t("partName")}</th>
                <th className="px-4 py-3 text-right">{t("partCost")}</th>
                <th className="px-4 py-3 text-right">{t("partPrice")}</th>
                <th className="px-4 py-3 text-right">{t("partStock")}</th>
                <th className="px-4 py-3 text-right">{t("partReorderLevel")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {parts.map((p) => {
                const low = p.qtyOnHand <= p.reorderLevel;
                return (
                  <tr key={p.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs">{p.sku}</td>
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/owner/inventory/${p.id}`} className="hover:underline">
                        {p.name}
                      </Link>
                      {p.autoCreatedFromLineId ? (
                        <span className="ms-2 rounded-full bg-info-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-info-700 dark:bg-info-500/10 dark:text-info-500">
                          {t("partAutoBadge")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {money(p.cost)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(p.price)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {p.qtyOnHand}
                      {low ? (
                        <span className="ml-2 rounded-full bg-danger-50 px-2 py-0.5 text-xs font-medium text-danger-700">
                          {t("lowStockTag")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {p.reorderLevel}
                    </td>
                  </tr>
                );
              })}
              {parts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                    {t("noPartsYet")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {partsWindow.totalCount > 0 ? (
          <Paginator
            currentPath="/owner/inventory"
            currentSearchParams={partsSearchParams}
            page={partsWindow.page}
            perPage={partsWindow.perPage}
            pageCount={partsWindow.pageCount}
            from={partsWindow.from}
            to={partsWindow.to}
            total={partsWindow.totalCount}
            perPageOptions={PER_PAGE_OPTIONS}
            labels={{
              showing: t("paginationShowing"),
              rowsPerPage: t("paginationRowsPerPage"),
              prev: t("paginationPrev"),
              next: t("paginationNext"),
            }}
          />
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
