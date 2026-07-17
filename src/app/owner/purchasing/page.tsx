import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { ButtonLink } from "@/components/ui/button";
import type { PurchaseOrderStatus } from "@/generated/prisma/client";
import {
  PURCHASE_ORDER_TABS,
  DEFAULT_PURCHASE_ORDER_TAB,
  purchaseOrderStatusLabelKey,
  statusToUrlParam,
  urlParamToStatus,
} from "@/lib/purchase-order-section";
import { Paginator } from "@/components/paginator";
import { PER_PAGE_OPTIONS, computeWindow } from "@/lib/pagination";

export const dynamic = "force-dynamic";

// Inventory 2a — purchase orders list. OWNER-only, garage-scoped. One tab
// per PurchaseOrderStatus (derived directly from the Prisma enum via
// PURCHASE_ORDER_TABS — a new status ships with a tab automatically, or
// the exhaustive helpers around it fail the build). Each tab is a flat
// paginated list of that status's POs.
export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    status?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const {
    error,
    status: rawStatus,
    page: rawPage,
    per: rawPer,
  } = await searchParams;
  const garageId = session.user.garageId;

  const currentStatus =
    urlParamToStatus(rawStatus) ?? DEFAULT_PURCHASE_ORDER_TAB;

  // Per-status counts fuel the tab badges. Single groupBy round trip
  // regardless of which tab is open. Zero-fill the map from
  // PURCHASE_ORDER_TABS so a status with no rows still renders its tab
  // with "0" rather than disappearing.
  const groups = await prisma.purchaseOrder.groupBy({
    by: ["status"],
    where: { garageId },
    _count: { _all: true },
  });
  const countByStatus = new Map<PurchaseOrderStatus, number>();
  for (const s of PURCHASE_ORDER_TABS) countByStatus.set(s, 0);
  for (const g of groups) {
    countByStatus.set(g.status as PurchaseOrderStatus, g._count._all);
  }

  const totalForCurrent = countByStatus.get(currentStatus) ?? 0;
  const pageWindow = computeWindow({
    rawPage,
    rawPer,
    totalCount: totalForCurrent,
  });

  const orders = await prisma.purchaseOrder.findMany({
    where: { garageId, status: currentStatus },
    orderBy: { createdAt: "desc" },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { qty: true, unitCost: true } },
    },
    skip: pageWindow.skip,
    take: pageWindow.take,
  });

  const money = (v: number) =>
    new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(v);
  const poTotal = (lines: { qty: number; unitCost: unknown }[]) =>
    lines.reduce((s, l) => s + l.qty * Number(l.unitCost), 0);

  // Paginator link builder: preserve ?status= so page/per navigation
  // stays inside the current tab. Tab links themselves reset page + per
  // so a switch always lands on page 1.
  const paginatorSearchParams = (() => {
    const p = new URLSearchParams();
    p.set("status", statusToUrlParam(currentStatus));
    return p.toString();
  })();

  return (
    <div>
      <AppNav role="OWNER" active="purchasing" />
      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("purchasingTitle")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("purchasingSubtitle")}
            </p>
          </div>
          <ButtonLink href="/owner/purchasing/new">
            {t("newPurchaseOrder")}
          </ButtonLink>
        </header>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {/* Tab strip — one tab per PurchaseOrderStatus, derived from the
            Prisma enum in PURCHASE_ORDER_TABS. Adding a new status to
            the schema surfaces a new tab automatically.
            Wraps to a second line on narrow viewports rather than
            horizontal-scrolling — a stale horizontal scrollbar under
            the tabs (Windows Chrome even when content nearly fits)
            was the visual bug in the first cut. */}
        <nav>
          <div className="flex flex-wrap items-center gap-1 gap-y-2 border-b border-border pb-2">
            {PURCHASE_ORDER_TABS.map((s) => {
              const isActive = s === currentStatus;
              const href = `/owner/purchasing?status=${statusToUrlParam(s)}`;
              const count = countByStatus.get(s) ?? 0;
              return (
                <Link
                  key={s}
                  href={href}
                  aria-current={isActive ? "page" : undefined}
                  className={
                    "inline-flex items-center gap-2 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition " +
                    (isActive
                      ? "bg-brand-900 text-white dark:bg-white dark:text-brand-900"
                      : "text-muted-foreground hover:bg-surface-2")
                  }
                >
                  {t(purchaseOrderStatusLabelKey(s))}
                  <span
                    className={
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums " +
                      (isActive
                        ? "bg-white/20 dark:bg-brand-900/20"
                        : "bg-surface-2")
                    }
                  >
                    {count}
                  </span>
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t("poSupplier")}</th>
                <th className="px-4 py-3">{t("poReference")}</th>
                <th className="px-4 py-3 text-right">{t("poLines")}</th>
                <th className="px-4 py-3 text-right">{t("poTotal")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">
                    <Link
                      href={`/owner/purchasing/${o.id}`}
                      className="hover:underline"
                    >
                      {o.supplier.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {o.reference ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {o.lines.length}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {money(poTotal(o.lines))}
                  </td>
                </tr>
              ))}
              {orders.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-12 text-center text-muted-foreground"
                  >
                    {t("noPurchaseOrders")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {totalForCurrent > 0 ? (
          <Paginator
            currentPath="/owner/purchasing"
            currentSearchParams={paginatorSearchParams}
            page={pageWindow.page}
            perPage={pageWindow.perPage}
            pageCount={pageWindow.pageCount}
            from={pageWindow.from}
            to={pageWindow.to}
            total={pageWindow.totalCount}
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

// Legacy sub-components (POTable + StatusBadge) removed with the section
// refactor — status is now conveyed by the active tab, so per-row badges
// are redundant. If we want them back later on the detail page, revive
// via git.
