import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import {
  addPoLineAction,
  removePoLineAction,
  setPoStatusAction,
} from "@/app/actions/purchasing";

export const dynamic = "force-dynamic";

// Inventory 2a — purchase order detail. Build lines while DRAFT, then send
// (→ ORDERED) or cancel. Receiving (→ RECEIVED, moves stock) arrives in 2b.
// OWNER-only, garage-scoped.
export default async function PurchaseOrderDetailPage({
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

  const po = await prisma.purchaseOrder.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      supplier: { select: { name: true } },
      lines: {
        orderBy: { createdAt: "asc" },
        include: { part: { select: { name: true, sku: true } } },
      },
    },
  });
  if (!po) notFound();

  const isDraft = po.status === "DRAFT";

  // Parts available to add (active, garage-scoped) for the line dropdown.
  const parts = isDraft
    ? await prisma.part.findMany({
        where: { garageId: session.user.garageId, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, sku: true, cost: true },
      })
    : [];

  const money = (v: number) =>
    new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(v);
  const total = po.lines.reduce((s, l) => s + l.qty * Number(l.unitCost), 0);

  return (
    <div>
      <AppNav role="OWNER" active="purchasing" />
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <div>
          <Link
            href="/owner/purchasing"
            className="text-xs uppercase tracking-widest text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("backToPurchasing")}
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {po.supplier.name}
            <span className="rounded-full bg-muted px-2 py-0.5 align-middle text-xs font-medium text-muted-foreground">
              {t(`poStatus_${po.status}`)}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {po.reference ? <>{t("poReference")}: {po.reference} · </> : null}
            {po.lines.length} {t("poLines").toLowerCase()} · {money(total)}
          </p>
          {po.note ? <p className="mt-1 text-sm text-muted-foreground">{po.note}</p> : null}
        </div>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {/* Lines */}
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t("partName")}</th>
                <th className="px-4 py-3 text-right">{t("adjustQty")}</th>
                <th className="px-4 py-3 text-right">{t("poUnitCost")}</th>
                <th className="px-4 py-3 text-right">{t("poLineTotal")}</th>
                {isDraft ? <th className="px-4 py-3" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {po.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3 font-medium">
                    {l.part.name} <span className="font-mono text-xs text-muted-foreground">{l.part.sku}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{l.qty}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{money(Number(l.unitCost))}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(l.qty * Number(l.unitCost))}</td>
                  {isDraft ? (
                    <td className="px-4 py-3 text-right">
                      <form action={removePoLineAction}>
                        <input type="hidden" name="poId" value={po.id} />
                        <input type="hidden" name="lineId" value={l.id} />
                        <button className="text-xs text-danger-700 hover:underline" type="submit">
                          {t("remove")}
                        </button>
                      </form>
                    </td>
                  ) : null}
                </tr>
              ))}
              {po.lines.length === 0 ? (
                <tr>
                  <td colSpan={isDraft ? 5 : 4} className="px-4 py-8 text-center text-muted-foreground">
                    {t("noPoLines")}
                  </td>
                </tr>
              ) : null}
            </tbody>
            {po.lines.length > 0 ? (
              <tfoot className="border-t border-border">
                <tr>
                  <td className="px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground" colSpan={3}>
                    {t("poTotal")}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(total)}</td>
                  {isDraft ? <td /> : null}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>

        {/* Add line — draft only */}
        {isDraft ? (
          <section className="space-y-3 rounded-xl border border-border p-4">
            <h2 className="text-base font-semibold tracking-tight">{t("addPoLine")}</h2>
            {parts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("noPartsForPo")}{" "}
                <Link href="/owner/inventory" className="font-medium text-foreground hover:underline">
                  {t("tabInventory")}
                </Link>
                .
              </p>
            ) : (
              <form action={addPoLineAction} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <input type="hidden" name="poId" value={po.id} />
                <label className="col-span-2 flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("partName")}</span>
                  <select name="partId" required defaultValue="" className="rounded-md border border-border bg-transparent px-3 py-2 text-sm">
                    <option value="" disabled>{t("choosePlaceholder")}</option>
                    {parts.map((p) => (
                      <option key={p.id} value={p.id} data-cost={String(p.cost)}>
                        {p.name} ({p.sku})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("adjustQty")}</span>
                  <input name="qty" type="number" min="1" required className="rounded-md border border-border bg-transparent px-3 py-2 text-sm" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("poUnitCost")}</span>
                  <input name="unitCost" type="number" step="0.01" min="0" required className="rounded-md border border-border bg-transparent px-3 py-2 text-sm" />
                </label>
                <div className="col-span-2 flex items-end sm:col-span-4">
                  <Button type="submit">{t("addPoLine")}</Button>
                </div>
              </form>
            )}
          </section>
        ) : null}

        {/* Status actions */}
        {po.status === "DRAFT" || po.status === "ORDERED" ? (
          <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4">
            {po.status === "DRAFT" ? (
              <form action={setPoStatusAction}>
                <input type="hidden" name="poId" value={po.id} />
                <input type="hidden" name="status" value="ORDERED" />
                <Button type="submit" variant="hero">{t("markOrdered")}</Button>
              </form>
            ) : null}
            <form action={setPoStatusAction}>
              <input type="hidden" name="poId" value={po.id} />
              <input type="hidden" name="status" value="CANCELLED" />
              <Button type="submit" variant="ghost">{t("cancelPo")}</Button>
            </form>
            {po.status === "ORDERED" ? (
              <span className="text-xs text-muted-foreground">{t("poReceivingSoon")}</span>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
