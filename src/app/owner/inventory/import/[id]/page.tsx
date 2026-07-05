import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { Button } from "@/components/ui/button";
import { confirmPartsImportAction, discardPartsImportAction } from "@/app/actions/parts-import";

export const dynamic = "force-dynamic";

// Inventory OCR import — REVIEW screen. The owner sees the OCR'd draft lines
// pre-filled into an editable table, fixes the flagged (low-confidence) rows,
// unchecks anything they don't want, and only THEN confirms. Nothing is in the
// catalog yet. OWNER-only, garage-scoped.
export default async function PartsImportReviewPage({
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

  const imp = await prisma.partsImport.findFirst({
    where: { id, garageId: session.user.garageId },
    include: { lines: { orderBy: { createdAt: "asc" } } },
  });
  if (!imp) notFound();

  const flaggedCount = imp.lines.filter((l) => l.flagged).length;
  const done = imp.status !== "DRAFT";

  return (
    <div>
      <AppNav role="OWNER" active="inventory" />
      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <div>
          <Link
            href="/owner/inventory"
            className="text-xs uppercase tracking-widest text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("backToInventory")}
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("importReviewTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {imp.supplierName ? <>{imp.supplierName} · </> : null}
            {imp.lines.length} {t("importDetected")}
            {flaggedCount > 0 ? (
              <span className="ms-2 rounded-full bg-warning-50 px-2 py-0.5 text-xs font-medium text-warning-600 dark:bg-warning-500/10">
                {flaggedCount} {t("importFlagged")}
              </span>
            ) : null}
          </p>
        </div>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {done ? (
          <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
            {t(`importStatus_${imp.status}` as MessageKey)}
          </p>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
          {/* Editable review table */}
          <div>
            {imp.lines.length === 0 ? (
              <p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
                {t("importNoLines")}
              </p>
            ) : (
              <form action={confirmPartsImportAction} className="space-y-4">
                <input type="hidden" name="importId" value={imp.id} />
                <input type="hidden" name="rowCount" value={imp.lines.length} />
                <div className="overflow-hidden rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-center">{t("importInclude")}</th>
                        <th className="px-3 py-2">{t("partName")}</th>
                        <th className="px-3 py-2">{t("partSku")}</th>
                        <th className="px-3 py-2 text-right">{t("adjustQty")}</th>
                        <th className="px-3 py-2 text-right">{t("poUnitCost")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {imp.lines.map((l, i) => (
                        <tr key={l.id} className={l.flagged && !done ? "bg-warning-50/50 dark:bg-warning-500/5" : ""}>
                          <td className="px-3 py-2 text-center align-middle">
                            <input
                              type="checkbox"
                              name="include"
                              value={i}
                              defaultChecked={!done}
                              disabled={done}
                              className="h-4 w-4 accent-brand-900"
                              aria-label={t("importInclude")}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              {l.flagged ? (
                                <span title={t("importFlaggedHint")} className="text-warning-600">⚠</span>
                              ) : null}
                              <input
                                name={`name_${i}`}
                                defaultValue={l.name}
                                placeholder={t("importNamePlaceholder")}
                                disabled={done}
                                className="w-full rounded-md border border-border bg-transparent px-2 py-1.5"
                              />
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <input
                              name={`sku_${i}`}
                              defaultValue={l.sku ?? ""}
                              placeholder={t("importSkuAuto")}
                              disabled={done}
                              className="w-28 rounded-md border border-border bg-transparent px-2 py-1.5 font-mono text-xs"
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              name={`qty_${i}`}
                              type="number"
                              min="0"
                              defaultValue={l.qty}
                              disabled={done}
                              className="w-20 rounded-md border border-border bg-transparent px-2 py-1.5 text-right tabular-nums"
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              name={`unitCost_${i}`}
                              type="number"
                              step="0.01"
                              min="0"
                              defaultValue={String(l.unitCost)}
                              disabled={done}
                              className="w-24 rounded-md border border-border bg-transparent px-2 py-1.5 text-right tabular-nums"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {!done ? (
                  <div className="flex items-center gap-3">
                    <Button type="submit" variant="hero">{t("importConfirm")}</Button>
                    <span className="text-xs text-muted-foreground">{t("importConfirmHint")}</span>
                  </div>
                ) : null}
              </form>
            )}

            {!done ? (
              <form action={discardPartsImportAction} className="mt-3">
                <input type="hidden" name="importId" value={imp.id} />
                <Button type="submit" variant="ghost">{t("importDiscard")}</Button>
              </form>
            ) : null}
          </div>

          {/* Source invoice image (audit) */}
          <aside className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("importSourcePhoto")}
            </h2>
            <a href={imp.imageUrl} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imp.imageUrl}
                alt={t("importSourcePhoto")}
                className="w-full rounded-xl border border-border object-contain"
              />
            </a>
          </aside>
        </div>
      </main>
    </div>
  );
}
