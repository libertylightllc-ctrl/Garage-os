import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import { createPartAction } from "@/app/actions/inventory";
import { startPartsImportAction } from "@/app/actions/parts-import";

export const dynamic = "force-dynamic";

// Inventory Phase 1, Slice 1 — parts catalog: add + list. OWNER-only,
// garage-scoped. Reads/creates catalog Part rows only; does NOT touch the
// job / estimate / part-request flow (that's Phase 3).
export default async function OwnerInventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; imported?: string; skipped?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const { error, imported, skipped } = await searchParams;

  const parts = await prisma.part.findMany({
    where: { garageId: session.user.garageId, active: true },
    orderBy: [{ name: "asc" }],
  });

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
