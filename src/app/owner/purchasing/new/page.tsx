import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import { createPurchaseOrderAction } from "@/app/actions/purchasing";

export const dynamic = "force-dynamic";

// Inventory 2a — new purchase order. Pick an active supplier; lines are
// added on the detail page after creation. OWNER-only, garage-scoped.
export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const { error } = await searchParams;

  const suppliers = await prisma.supplier.findMany({
    where: { garageId: session.user.garageId, active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return (
    <div>
      <AppNav role="OWNER" active="purchasing" />
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <div>
          <Link
            href="/owner/purchasing"
            className="text-xs uppercase tracking-widest text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("backToPurchasing")}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("newPurchaseOrder")}</h1>
        </div>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {suppliers.length === 0 ? (
          <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
            {t("noSuppliersForPo")}{" "}
            <Link href="/owner/suppliers" className="font-medium text-foreground hover:underline">
              {t("tabSuppliers")}
            </Link>
            .
          </p>
        ) : (
          <form action={createPurchaseOrderAction} className="space-y-4 rounded-xl border border-border p-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("poSupplier")}</span>
              <select
                name="supplierId"
                required
                defaultValue=""
                className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              >
                <option value="" disabled>
                  {t("choosePlaceholder")}
                </option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("poReference")}</span>
              <input name="reference" className="rounded-md border border-border bg-transparent px-3 py-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("poNote")}</span>
              <input name="note" className="rounded-md border border-border bg-transparent px-3 py-2 text-sm" />
            </label>
            <Button type="submit">{t("createDraftPo")}</Button>
          </form>
        )}
      </main>
    </div>
  );
}
