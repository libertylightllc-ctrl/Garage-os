import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import { createPurchaseOrderAction } from "@/app/actions/purchasing";
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";

export const dynamic = "force-dynamic";

// Inventory 2a — new PO shell. Pick an active supplier; lines are added
// on the detail page after creation. OWNER-only, garage-scoped.
//
// Two-mode (2026-08-02): the page reads `?mode=quote|order` and shapes
// title, hint, submit label, and hidden `mode` form input. Both modes
// write the same DRAFT PO row — the mode only carries through as a
// query param to the detail page so the add-line cost input can be
// `required` on order mode and optional on quote mode. Server-side the
// create action is agnostic (Layer 0 accepts null unitCost).
export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mode?: string }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const { error, mode: rawMode } = await searchParams;
  // Whitelist the mode — anything else defaults to `quote` (the safer
  // shape: cost optional, no committing language). Prevents an
  // unfamiliar query string from silently steering the UI.
  const mode: "quote" | "order" = rawMode === "order" ? "order" : "quote";
  const title = mode === "order" ? t("newPurchaseOrder") : t("newQuotation");
  const hint = mode === "order" ? t("newPurchaseOrderHint") : t("newQuotationHint");
  const submitLabel = mode === "order" ? t("createPurchaseOrder") : t("createQuotation");

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
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
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
          <form id="new-po-form" action={createPurchaseOrderAction} className="space-y-4 rounded-xl border border-border p-4">
            <UnsavedChangesGuard formId="new-po-form" />
            {/* Mode passthrough — the server action reads this to
                redirect to the detail page with ?mode= so the add-line
                cost input can render as required (order) or optional
                (quote). No server-side write difference. */}
            <input type="hidden" name="mode" value={mode} />
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
            <Button type="submit">{submitLabel}</Button>
          </form>
        )}
      </main>
    </div>
  );
}
