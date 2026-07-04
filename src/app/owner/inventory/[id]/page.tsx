import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import { updatePartAction, adjustStockAction } from "@/app/actions/inventory";

export const dynamic = "force-dynamic";

// Inventory 1b — part detail: edit the catalog fields + adjust stock with
// a required reason + see recent stock changes. OWNER-only, garage-scoped.
// Reads/writes only Part + PartMovement; does NOT touch the job/estimate
// flow.
export default async function PartDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const { id } = await params;
  const { error } = await searchParams;

  const part = await prisma.part.findFirst({
    where: { id, garageId: session.user.garageId },
  });
  if (!part) notFound();

  const movements = await prisma.partMovement.findMany({
    where: { partId: part.id },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const low = part.qtyOnHand <= part.reorderLevel;

  return (
    <div>
      <AppNav role="OWNER" active="inventory" />
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <div>
          <Link
            href="/owner/inventory"
            className="text-xs uppercase tracking-widest text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("backToInventory")}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{part.name}</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{part.sku}</span> · {t("currentStock")}:{" "}
            <span className="tabular-nums font-medium text-foreground">{part.qtyOnHand}</span>
            {low ? (
              <span className="ml-2 rounded-full bg-danger-50 px-2 py-0.5 text-xs font-medium text-danger-700">
                {t("lowStockTag")}
              </span>
            ) : null}
          </p>
        </div>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {/* Edit details */}
        <section className="space-y-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold tracking-tight">{t("editPart")}</h2>
          <form action={updatePartAction} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <input type="hidden" name="partId" value={part.id} />
            <Field name="sku" label={t("partSku")} defaultValue={part.sku} required />
            <Field name="name" label={t("partName")} defaultValue={part.name} required className="col-span-2" />
            <Field name="cost" label={t("partCost")} type="number" step="0.01" min="0" defaultValue={String(part.cost)} required />
            <Field name="price" label={t("partPrice")} type="number" step="0.01" min="0" defaultValue={String(part.price)} required />
            <Field name="reorderLevel" label={t("partReorderLevel")} type="number" min="0" defaultValue={String(part.reorderLevel)} />
            <div className="col-span-2 flex items-end sm:col-span-3">
              <Button type="submit">{t("saveChanges")}</Button>
            </div>
          </form>
        </section>

        {/* Adjust stock */}
        <section className="space-y-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold tracking-tight">{t("adjustStock")}</h2>
          <form action={adjustStockAction} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <input type="hidden" name="partId" value={part.id} />
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("adjustDirection")}
              </span>
              <select
                name="direction"
                defaultValue="add"
                className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              >
                <option value="add">{t("adjustAdd")}</option>
                <option value="remove">{t("adjustRemove")}</option>
              </select>
            </label>
            <Field name="qty" label={t("adjustQty")} type="number" min="1" required />
            <Field
              name="reason"
              label={t("adjustReason")}
              hint={t("adjustReasonHint")}
              required
              className="col-span-2"
            />
            <div className="col-span-2 flex items-end sm:col-span-4">
              <Button type="submit">{t("applyAdjustment")}</Button>
            </div>
          </form>
        </section>

        {/* Recent movements */}
        <section className="space-y-3">
          <h2 className="text-base font-semibold tracking-tight">{t("recentMovements")}</h2>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">{t("movementWhen")}</th>
                  <th className="px-4 py-2 text-right">{t("movementChange")}</th>
                  <th className="px-4 py-2">{t("adjustReason")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-2 text-muted-foreground">
                      {m.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums font-medium ${
                        m.delta >= 0 ? "text-success-700" : "text-danger-700"
                      }`}
                    >
                      {m.delta >= 0 ? "+" : ""}
                      {m.delta}
                    </td>
                    <td className="px-4 py-2">{m.reason}</td>
                  </tr>
                ))}
                {movements.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                      {t("noMovements")}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function Field({
  label,
  hint,
  className,
  ...input
}: {
  label: string;
  hint?: string;
  className?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <input
        {...input}
        className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
      />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
