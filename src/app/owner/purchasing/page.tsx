import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT, getLocale } from "@/i18n/server";
import { ButtonLink } from "@/components/ui/button";
import type { PurchaseOrderStatus, Prisma } from "@/generated/prisma/client";
import {
  PURCHASE_ORDER_TABS,
  DEFAULT_PURCHASE_ORDER_TAB,
  purchaseOrderStatusLabelKey,
  statusToUrlParam,
  urlParamToStatus,
} from "@/lib/purchase-order-section";
import { Paginator } from "@/components/paginator";
import { PER_PAGE_OPTIONS, computeWindow } from "@/lib/pagination";
import { poDocKind } from "@/lib/po-doc-kind";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { relativeTime } from "@/lib/relative-time";

export const dynamic = "force-dynamic";

// Inventory 2a — purchase orders list. OWNER-only, garage-scoped.
//
// Two orthogonal filter axes:
//   • Status (tab strip) — DRAFT / ORDERED / PARTIALLY_RECEIVED / RECEIVED /
//     CANCELLED. Derived from the Prisma enum via PURCHASE_ORDER_TABS.
//   • Document kind (?kind=) + Send state (?sent=) — pushed into the Prisma
//     `where` clause so pagination stays honest. Combining these captures
//     the question this page has to answer at a glance: "which RFQs went
//     out and haven't come back yet." Kind=RFQ + sent=sent + status=DRAFT
//     surfaces exactly that set.
//
// Row shape (one PO per row):
//   Document #  ·  Kind  ·  Supplier  ·  Vehicle / Job  ·  Total  ·  Created  ·  Last sent
// where:
//   • Total is blank for RFQs. An RFQ by definition has at least one
//     unpriced line, so the sum isn't a real commitment.
//   • Vehicle/Job is derived from PurchaseOrderLine snapshot columns —
//     grouped by vehicleId (or plate+jobNumber when null). One vehicle
//     across all lines → shown; multiple → "Multiple vehicles" chip; none
//     → "—".
//   • Last sent reads the newest PurchaseOrderSend row (any channel).
//     "Not sent" when there are no rows. For RFQs that were sent 2+ days
//     ago with no PO status advance, the "waiting Nd" chip fires so the
//     row stands out — that's the "an RFQ five days ago with no reply" the
//     spec calls out.

type KindFilter = "all" | "PO" | "RFQ";
type SentFilter = "all" | "sent" | "unsent";

function parseKindFilter(raw: string | undefined): KindFilter {
  return raw === "PO" || raw === "RFQ" ? raw : "all";
}
function parseSentFilter(raw: string | undefined): SentFilter {
  return raw === "sent" || raw === "unsent" ? raw : "all";
}

/** Vehicle summary for the row: single, multiple, or none. Derived from
 *  the line snapshot columns — no join to Vehicle needed. Matches the
 *  detail page's grouping logic (`resolvePoVehicles`) but with a
 *  narrower input shape since the list only needs a display label. */
type VehicleSummary =
  | { kind: "none" }
  | { kind: "one"; label: string }
  | { kind: "many"; count: number };

function summarizeVehicles(
  lines: Array<{
    vehicleId: string | null;
    vehicleMake: string | null;
    vehicleModel: string | null;
    vehicleYear: number | null;
    vehiclePlate: string | null;
    vehicleJobNumber: number | null;
  }>,
): VehicleSummary {
  // Group by vehicle identity ALONE — vehicleId when present, else
  // plate. Job numbers are per-line context ("this part was ordered
  // for JC-12 on that car"), NOT part of vehicle identity — collect
  // them into a set so the summary lists "JC-12, JC-14" under one row
  // instead of splitting the same car into two "vehicles" the moment
  // it appears on two jobs. Previous key `plate|jobNumber` caused the
  // "2 vehicles" false count on POs that touched one car across two
  // jobs.
  const seen = new Map<
    string,
    {
      make: string;
      model: string;
      year: number | null;
      plate: string;
      jobNumbers: Set<number>;
    }
  >();
  for (const l of lines) {
    // Fully-null vehicle (catalog buy with no context) — skip. Not a
    // "vehicle" for grouping purposes.
    if (
      l.vehicleId === null &&
      l.vehicleMake === null &&
      l.vehiclePlate === null &&
      l.vehicleJobNumber === null
    ) {
      continue;
    }
    // Prefer vehicleId; fall back to plate. Namespace the fallback so
    // a bare plate string can never collide with a Vehicle UUID.
    const key = l.vehicleId ?? `plate:${l.vehiclePlate ?? ""}`;
    const existing = seen.get(key);
    if (existing) {
      if (l.vehicleJobNumber != null) existing.jobNumbers.add(l.vehicleJobNumber);
    } else {
      const jobNumbers = new Set<number>();
      if (l.vehicleJobNumber != null) jobNumbers.add(l.vehicleJobNumber);
      seen.set(key, {
        make: l.vehicleMake ?? "",
        model: l.vehicleModel ?? "",
        year: l.vehicleYear,
        plate: l.vehiclePlate ?? "",
        jobNumbers,
      });
    }
  }
  if (seen.size === 0) return { kind: "none" };
  if (seen.size === 1) {
    const v = [...seen.values()][0];
    const jobList = [...v.jobNumbers].sort((a, b) => a - b);
    const jobLabel = jobList.length
      ? jobList.map((n) => `JC-${n}`).join(", ")
      : "";
    const bits = [
      jobLabel,
      [v.make, v.model, v.year != null ? String(v.year) : ""].filter(Boolean).join(" "),
      v.plate,
    ].filter(Boolean);
    return { kind: "one", label: bits.join(" · ") };
  }
  return { kind: "many", count: seen.size };
}

export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    status?: string;
    kind?: string;
    sent?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const locale = await getLocale();
  const {
    error,
    status: rawStatus,
    kind: rawKind,
    sent: rawSent,
    page: rawPage,
    per: rawPer,
  } = await searchParams;
  const garageId = session.user.garageId;

  const currentStatus = urlParamToStatus(rawStatus) ?? DEFAULT_PURCHASE_ORDER_TAB;
  const currentKind = parseKindFilter(rawKind);
  const currentSent = parseSentFilter(rawSent);

  // Per-status counts still fuel the tab badges. Kept independent of
  // the kind/sent filters — the tab count reflects the total for that
  // status, not the filtered subset. If we counted the filtered subset,
  // switching tabs would show badges that don't match what you actually
  // find on that tab.
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

  // Build the where clause. Kind + sent filters push into Prisma so
  // pagination reflects the filtered set, not the pre-filtered set with
  // gaps.
  //
  // Kind SQL matches poDocKind's list collapse (2026-08-02):
  //   PO  ≡  status IN (ORDERED, PARTIALLY_RECEIVED, RECEIVED)
  //          OR (status = CANCELLED AND orderedAt IS NOT NULL)
  //          OR (status = DRAFT AND intent = ORDER)
  //   RFQ ≡  (status = DRAFT AND intent = QUOTE)
  //          OR (status = CANCELLED AND orderedAt IS NULL)
  //
  // PO_DRAFT rolls into PO for the list — a DRAFT+ORDER doc belongs
  // in the PO bucket even before Mark Ordered is clicked (the owner
  // knows the price and intends to order). The detail-page title
  // keeps the three-way "Purchase Order (draft)" distinction where it
  // matters. Older rows without intent backfilled to QUOTE by the
  // 2026-08-02 migration.
  const where: Prisma.PurchaseOrderWhereInput = {
    garageId,
    status: currentStatus,
  };
  const andClauses: Prisma.PurchaseOrderWhereInput[] = [];
  const PO_ORDERED_STATUSES: PurchaseOrderStatus[] = [
    "ORDERED",
    "PARTIALLY_RECEIVED",
    "RECEIVED",
  ];
  if (currentKind === "PO") {
    andClauses.push({
      OR: [
        { status: { in: PO_ORDERED_STATUSES } },
        { status: "CANCELLED", orderedAt: { not: null } },
        { status: "DRAFT", intent: "ORDER" },
      ],
    });
  } else if (currentKind === "RFQ") {
    andClauses.push({
      OR: [
        { status: "DRAFT", intent: "QUOTE" },
        { status: "CANCELLED", orderedAt: null },
      ],
    });
  }
  if (currentSent === "sent") {
    andClauses.push({ sends: { some: {} } });
  } else if (currentSent === "unsent") {
    andClauses.push({ sends: { none: {} } });
  }
  if (andClauses.length > 0) where.AND = andClauses;

  const totalForFiltered = await prisma.purchaseOrder.count({ where });
  const pageWindow = computeWindow({
    rawPage,
    rawPer,
    totalCount: totalForFiltered,
  });

  const orders = await prisma.purchaseOrder.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      supplier: { select: { name: true } },
      lines: {
        select: {
          qty: true,
          unitCost: true,
          vehicleId: true,
          vehicleMake: true,
          vehicleModel: true,
          vehicleYear: true,
          vehiclePlate: true,
          vehicleJobNumber: true,
        },
      },
      // Newest send only — the "last send" column just needs the tip
      // of the history. The detail page loads the full audit trail.
      sends: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { channel: true, createdAt: true, status: true },
      },
    },
    skip: pageWindow.skip,
    take: pageWindow.take,
  });

  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { country: true },
  });
  const tz = countryToTimeZone(garage?.country ?? "UAE");
  const money = (v: number) =>
    new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(v);
  const poTotal = (lines: readonly { qty: number; unitCost: unknown }[]) =>
    lines.reduce((s, l) => s + l.qty * Number(l.unitCost), 0);
  const now = new Date();
  const daysBetween = (from: Date): number =>
    Math.floor((now.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));

  // Query-string helper — preserves the current filter axes across
  // pagination and tab navigation. Callers pass just the axes they
  // want to override.
  const buildQuery = (
    overrides: Partial<{
      status: string;
      kind: KindFilter;
      sent: SentFilter;
      page: string;
      per: string;
    }>,
  ): string => {
    const p = new URLSearchParams();
    const s = overrides.status ?? statusToUrlParam(currentStatus);
    if (s) p.set("status", s);
    const k = overrides.kind ?? currentKind;
    if (k !== "all") p.set("kind", k);
    const se = overrides.sent ?? currentSent;
    if (se !== "all") p.set("sent", se);
    if (overrides.page) p.set("page", overrides.page);
    if (overrides.per) p.set("per", overrides.per);
    return p.toString();
  };

  // Paginator preserves ALL current filters. Tab links reset kind/sent
  // to keep tab switching predictable — a tab click always shows the
  // full set of that status, and the filter pills stay visible so the
  // owner can re-apply.
  const paginatorSearchParams = buildQuery({});

  const filterPillClass = (isActive: boolean): string =>
    "inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition " +
    (isActive
      ? "bg-brand-900 text-white dark:bg-white dark:text-brand-900"
      : "border border-border text-muted-foreground hover:bg-surface-2");

  return (
    <div>
      <AppNav role="OWNER" active="purchasing" />
      <main className="mx-auto max-w-6xl space-y-6 p-6">
        {/* Two-mode purchasing entry (2026-08-02). Two distinct actions
            from one page: ask a supplier to quote (RFQ) vs. place an
            order at known prices. Both routes land on the same shell
            form (/owner/purchasing/new) differentiated by ?mode=; the
            server writes a DRAFT PO in both cases per AR's rule that
            Mark Ordered is the ONLY thing turning a quotation into a
            purchase order.

            Layout: on narrow viewports the header stacks (title on top,
            buttons below) so the buttons clear the fixed EN/ع language
            toggle in the top-right of the app. The buttons wrap when
            the row is too tight — the three-way row (from-estimate,
            new-quote, new-order) is the widest on this surface. */}
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1 pt-12 sm:pt-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("purchasingTitle")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("purchasingSubtitle")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 sm:shrink-0">
            <ButtonLink href="/owner/purchasing/from-estimate" variant="ghost">
              {t("convertFromEstimate")}
            </ButtonLink>
            <ButtonLink href="/owner/purchasing/new?mode=quote" variant="ghost">
              {t("newQuotation")}
            </ButtonLink>
            <ButtonLink href="/owner/purchasing/new?mode=order">
              {t("newPurchaseOrder")}
            </ButtonLink>
          </div>
        </header>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {/* Status tab strip — unchanged shape. See file header. */}
        <nav>
          <div className="flex flex-wrap items-center gap-1 gap-y-2 border-b border-border pb-2">
            {PURCHASE_ORDER_TABS.map((s) => {
              const isActive = s === currentStatus;
              // Carry kind + sent through the tab switch. "Show me
              // unsent RFQs across statuses" is a real cross-status
              // question — resetting on tab click made the owner
              // re-apply both filters every time.
              const href = `/owner/purchasing?${buildQuery({
                status: statusToUrlParam(s),
                page: "",
              })}`;
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

        {/* Filter pills — orthogonal to the status tab. Kind (All / PO
            / RFQ) and Sent (All / Sent / Not sent). ONE click applies;
            no submit button. Pagination resets to page 1 by omitting
            page from the href. */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t("purchasingFilterKindLabel")}</span>
            {(["all", "PO", "RFQ"] as const).map((k) => (
              <Link
                key={k}
                href={`/owner/purchasing?${buildQuery({ kind: k, page: "" })}`}
                className={filterPillClass(currentKind === k)}
                aria-pressed={currentKind === k}
              >
                {t(
                  k === "all"
                    ? "purchasingFilterKindAll"
                    : k === "PO"
                      ? "purchasingFilterKindPO"
                      : "purchasingFilterKindRFQ",
                )}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t("purchasingFilterSentLabel")}</span>
            {(["all", "sent", "unsent"] as const).map((s) => (
              <Link
                key={s}
                href={`/owner/purchasing?${buildQuery({ sent: s, page: "" })}`}
                className={filterPillClass(currentSent === s)}
                aria-pressed={currentSent === s}
              >
                {t(
                  s === "all"
                    ? "purchasingFilterSentAll"
                    : s === "sent"
                      ? "purchasingFilterSentSent"
                      : "purchasingFilterSentUnsent",
                )}
              </Link>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t("poDocNumberCol")}</th>
                <th className="px-4 py-3">{t("poKindCol")}</th>
                <th className="px-4 py-3">{t("poSupplier")}</th>
                <th className="px-4 py-3">{t("poVehicleCol")}</th>
                <th className="px-4 py-3 text-right">{t("poTotal")}</th>
                <th className="px-4 py-3">{t("poCreatedCol")}</th>
                <th className="px-4 py-3">{t("poLastSentCol")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((o) => {
                // 2026-08-02: collapse PO_DRAFT into "PO" for the list
                // display. The list shows a two-way kind chip (PO / RFQ)
                // — a DRAFT+ORDER doc belongs in the PO bucket (owner
                // knows the price and intends to order) even before
                // Mark Ordered is clicked. The detail page keeps the
                // three-way title ("Purchase Order (draft)") so the
                // uncommitted state is still visible where it matters.
                const rawKind = poDocKind({
                  status: o.status,
                  orderedAt: o.orderedAt,
                  intent: o.intent,
                });
                const kind: "PO" | "RFQ" = rawKind === "RFQ" ? "RFQ" : "PO";
                const docNumber = o.reference?.trim()
                  ? o.reference
                  : `#${o.id.slice(-6).toUpperCase()}`;
                const vehicleSummary = summarizeVehicles(o.lines);
                const lastSend = o.sends[0] ?? null;
                const daysSinceSend = lastSend ? daysBetween(lastSend.createdAt) : null;
                // The RFQ waiting badge — spec ask: an RFQ sent 5 days
                // ago with no reply is the row that needs action.
                // Threshold: 2+ days on an RFQ that's still DRAFT
                // (which means the advisor hasn't converted it to a PO
                // yet — no prices filled in). Threshold is deliberately
                // loose; it's a hint, not an alarm.
                const showWaitingBadge =
                  kind === "RFQ" &&
                  currentStatus === "DRAFT" &&
                  daysSinceSend !== null &&
                  daysSinceSend >= 2;
                return (
                  <tr key={o.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium tabular-nums">
                      <Link
                        href={`/owner/purchasing/${o.id}`}
                        className="hover:underline"
                      >
                        {docNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          "inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider " +
                          (kind === "RFQ"
                            ? "bg-warning-50 text-warning-700 dark:bg-warning-500/10 dark:text-warning-500"
                            : "bg-surface-2 text-muted-foreground")
                        }
                      >
                        {kind === "PO" ? t("sendDocChip_PO") : t("sendDocChip_RFQ")}
                      </span>
                    </td>
                    <td className="px-4 py-3">{o.supplier.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {vehicleSummary.kind === "one" ? (
                        <span>{vehicleSummary.label}</span>
                      ) : vehicleSummary.kind === "many" ? (
                        <span className="inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-xs">
                          {t("poVehicleMultiple").replace(
                            "{count}",
                            String(vehicleSummary.count),
                          )}
                        </span>
                      ) : (
                        <span>—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {kind === "PO" ? money(poTotal(o.lines)) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {fmtDate(o.createdAt, locale, tz)}
                    </td>
                    <td className="px-4 py-3">
                      {lastSend ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span>
                            {lastSend.channel === "WHATSAPP"
                              ? t("sendChannel_WHATSAPP")
                              : t("sendChannel_EMAIL")}
                            {" · "}
                            <span className="text-muted-foreground">
                              {relativeTime(lastSend.createdAt, locale)}
                            </span>
                          </span>
                          {showWaitingBadge ? (
                            <span className="inline-flex items-center rounded-md bg-warning-50 px-1.5 py-0.5 text-xs font-semibold text-warning-700 dark:bg-warning-500/10 dark:text-warning-500">
                              {t("poWaitingForQuote").replace(
                                "{days}",
                                String(daysSinceSend),
                              )}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">{t("poNotSent")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {orders.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-12 text-center text-muted-foreground"
                  >
                    {t("noPurchaseOrders")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {totalForFiltered > 0 ? (
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
