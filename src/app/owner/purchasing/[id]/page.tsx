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
  receivePurchaseOrderAction,
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
  // Receiving surfaces once the PO has been sent. `showReceiving` reveals the
  // received/outstanding columns; `canReceive` shows the receive form (still
  // has outstanding qty to take in).
  const showReceiving =
    po.status === "ORDERED" || po.status === "PARTIALLY_RECEIVED" || po.status === "RECEIVED";
  const canReceive = po.status === "ORDERED" || po.status === "PARTIALLY_RECEIVED";

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

        {/* Fully received banner */}
        {po.status === "RECEIVED" && po.receivedAt ? (
          <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
            {t("poReceivedBanner")} {po.receivedAt.toISOString().slice(0, 10)}
          </p>
        ) : null}

        {/* Lines */}
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t("partName")}</th>
                <th className="px-4 py-3 text-right">{t("poOrdered")}</th>
                {showReceiving ? <th className="px-4 py-3 text-right">{t("poReceived")}</th> : null}
                {showReceiving ? <th className="px-4 py-3 text-right">{t("poOutstanding")}</th> : null}
                <th className="px-4 py-3 text-right">{t("poUnitCost")}</th>
                <th className="px-4 py-3 text-right">{t("poLineTotal")}</th>
                {isDraft ? <th className="px-4 py-3" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {po.lines.map((l) => {
                const outstanding = l.qty - l.receivedQty;
                return (
                  <tr key={l.id}>
                    <td className="px-4 py-3 font-medium">
                      {l.part.name} <span className="font-mono text-xs text-muted-foreground">{l.part.sku}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{l.qty}</td>
                    {showReceiving ? (
                      <td className="px-4 py-3 text-right tabular-nums">{l.receivedQty}</td>
                    ) : null}
                    {showReceiving ? (
                      <td
                        className={
                          "px-4 py-3 text-right tabular-nums " +
                          (outstanding > 0 ? "font-medium text-warning-600" : "text-muted-foreground")
                        }
                      >
                        {outstanding}
                      </td>
                    ) : null}
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
                );
              })}
              {po.lines.length === 0 ? (
                <tr>
                  <td colSpan={isDraft ? 5 : 4} className="px-4 py-8 text-center text-muted-foreground">
                    {t("noPoLines")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Receive delivery — PARTIAL receiving (2b). Enter how many of each
            line arrived NOW (≤ outstanding). Defaults to the full outstanding
            for a one-tap "everything arrived", but can be reduced for a
            partial delivery; receive again later for the rest. */}
        {canReceive ? (
          <section className="space-y-3 rounded-xl border border-border p-4">
            <h2 className="text-base font-semibold tracking-tight">{t("poReceiveHeading")}</h2>
            <p className="text-xs text-muted-foreground">{t("poReceiveHint")}</p>
            <form action={receivePurchaseOrderAction} className="space-y-2">
              <input type="hidden" name="poId" value={po.id} />
              {po.lines.map((l) => {
                const outstanding = l.qty - l.receivedQty;
                return (
                  <div key={l.id} className="flex items-center justify-between gap-3 border-b border-border/60 pb-2 last:border-0">
                    <span className="min-w-0 truncate text-sm">
                      {l.part.name}
                      <span className="ms-2 text-xs text-muted-foreground">
                        {l.receivedQty}/{l.qty} {t("poReceivedLower")}
                        {outstanding > 0 ? <> · {outstanding} {t("poOutstandingLower")}</> : null}
                      </span>
                    </span>
                    {outstanding > 0 ? (
                      <input
                        name={`recv_${l.id}`}
                        type="number"
                        min="0"
                        max={outstanding}
                        defaultValue={outstanding}
                        aria-label={t("poReceiveNow")}
                        className="w-20 shrink-0 rounded-md border border-border bg-transparent px-2 py-1.5 text-right text-sm tabular-nums"
                      />
                    ) : (
                      <span className="shrink-0 text-xs font-medium text-success-700 dark:text-success-500">✓</span>
                    )}
                  </div>
                );
              })}
              <div className="pt-1">
                <Button type="submit" variant="hero">{t("poReceiveButton")}</Button>
              </div>
            </form>
          </section>
        ) : null}

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
          </section>
        ) : null}
      </main>
    </div>
  );
}
