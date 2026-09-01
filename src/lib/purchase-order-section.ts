// Routing helpers for the owner purchasing page. Every function below is
// EXHAUSTIVE over its input type via a `never` default arm — TypeScript
// fails the build the moment a new tab or status ships without being
// routed here. That closes the class of bug where a new enum value
// silently drops rows out of the UI (the exact bug that had
// PARTIALLY_RECEIVED disappearing before this file existed).

import { Prisma, PurchaseOrderStatus } from "@/generated/prisma/client";
import type { MessageKey } from "@/i18n/config";

export type PurchaseOrderSection = "OPEN" | "CLOSED";

/** Which section a purchase order renders in.
 *   OPEN  — parts are still owed / work pending
 *   CLOSED — terminal, no follow-up needed
 *
 * PARTIALLY_RECEIVED belongs in OPEN: some qty has arrived but there is
 * still an outstanding balance to receive, so the owner still has work
 * to chase on this PO.
 *
 * Kept even though the UI has moved to per-status tabs — the coarse
 * grouping is still useful for aggregate reports. */
export function purchaseOrderSection(
  status: PurchaseOrderStatus,
): PurchaseOrderSection {
  switch (status) {
    case "DRAFT":
    case "ORDERED":
    case "PARTIALLY_RECEIVED":
      return "OPEN";
    case "RECEIVED":
    case "CANCELLED":
      return "CLOSED";
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled PurchaseOrderStatus: ${_exhaustive}`);
    }
  }
}

/** i18n label key per SCHEMA status. Kept for surfaces that render the
 *  raw status (detail-page banner, print doc footer, admin logs).
 *  The purchasing-page tab strip uses `purchaseOrderTabLabelKey`
 *  instead — the tab list is a display concept, not a schema mirror. */
export function purchaseOrderStatusLabelKey(
  status: PurchaseOrderStatus,
): MessageKey {
  switch (status) {
    case "DRAFT":
      return "poStatus_DRAFT";
    case "ORDERED":
      return "poStatus_ORDERED";
    case "PARTIALLY_RECEIVED":
      return "poStatus_PARTIALLY_RECEIVED";
    case "RECEIVED":
      return "poStatus_RECEIVED";
    case "CANCELLED":
      return "poStatus_CANCELLED";
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled PurchaseOrderStatus: ${_exhaustive}`);
    }
  }
}

// ── Tab-level display concept (AR 2026-08-17) ──────────────────────
//
// The purchasing-page tabs used to mirror the PurchaseOrderStatus enum
// 1-for-1. That lumped never-sent DRAFTs and sent-and-awaiting-supplier
// DRAFTs under a single "Draft" tab — the operator couldn't tell what
// needed their action vs what was waiting on the supplier.
//
// Split the DRAFT bucket into two action-oriented tabs:
//   UNSENT_DRAFT      — owner needs to hit Send  (status=DRAFT, no sends)
//   AWAITING_SUPPLIER — supplier owes a reply    (status=DRAFT, ≥1 send)
//
// The other four tabs pass through 1-for-1 to their schema statuses.
//
// This is a DISPLAY split, not a schema split. Mark Ordered is still
// the only thing that flips DRAFT → ORDERED; nothing here touches
// PurchaseOrderStatus. See src/lib/po-doc-kind.ts →
// poStatusDisplayKey for the sibling detail-page label rule.

export type PurchaseOrderTab =
  | "UNSENT_DRAFT"
  | "AWAITING_SUPPLIER"
  | "ORDERED"
  | "PARTIALLY_RECEIVED"
  | "RECEIVED"
  | "CANCELLED";

/** Tab order shown on the purchasing page. Left-to-right matches the
 *  workflow: what needs sending → what's waiting on the supplier →
 *  what's ordered → arriving in pieces → complete → cancelled. */
export const PURCHASE_ORDER_TABS: readonly PurchaseOrderTab[] = [
  "UNSENT_DRAFT",
  "AWAITING_SUPPLIER",
  "ORDERED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
];

/** Default tab when no ?status= is present. ORDERED is the "real work
 *  in flight" bucket — unsent drafts are paperwork, terminal statuses
 *  are read-only, so ORDERED is where the owner most often wants to
 *  land.
 *
 *  Used as the FALLBACK for pickDefaultTab (below) when every tab has
 *  a zero count — a brand-new tenant lands on ORDERED with empty
 *  copy. For an active tenant with data, pickDefaultTab prefers the
 *  first non-empty tab in the display order so the operator doesn't
 *  land on a lie ("no purchase orders" when there ARE purchase
 *  orders, just in another tab). AR 2026-08-30 bug #1. */
export const DEFAULT_PURCHASE_ORDER_TAB: PurchaseOrderTab = "ORDERED";

/** Pick the tab to land on when no ?status= is in the URL. Prefers
 *  the first non-empty tab in the display order (UNSENT_DRAFT →
 *  AWAITING_SUPPLIER → ORDERED → PARTIALLY_RECEIVED → RECEIVED →
 *  CANCELLED) so a working shop lands on ORDERED (the most common
 *  populated tab), a fresh tenant lands on UNSENT_DRAFT once they
 *  have a draft, and an empty tenant falls back to
 *  DEFAULT_PURCHASE_ORDER_TAB (still ORDERED — its 0 counter with
 *  the tab-specific empty-state copy reads honestly). AR 2026-08-30
 *  bug #1. */
export function pickDefaultTab(
  countByTab: ReadonlyMap<PurchaseOrderTab, number>,
): PurchaseOrderTab {
  // Prefer ORDERED specifically if it has POs — that's the "real
  // work in flight" bucket the owner wants first, per the same
  // reasoning DEFAULT_PURCHASE_ORDER_TAB pins.
  if ((countByTab.get("ORDERED") ?? 0) > 0) return "ORDERED";
  for (const tab of PURCHASE_ORDER_TABS) {
    if ((countByTab.get(tab) ?? 0) > 0) return tab;
  }
  return DEFAULT_PURCHASE_ORDER_TAB;
}

/** i18n label key per tab. The two draft tabs get their own keys
 *  ("To send" / "Awaiting supplier"); the rest reuse the existing
 *  status labels because the tab and status names are the same. */
export function purchaseOrderTabLabelKey(tab: PurchaseOrderTab): MessageKey {
  switch (tab) {
    case "UNSENT_DRAFT":
      return "poTab_UNSENT_DRAFT";
    case "AWAITING_SUPPLIER":
      return "poTab_AWAITING_SUPPLIER";
    case "ORDERED":
      return "poStatus_ORDERED";
    case "PARTIALLY_RECEIVED":
      return "poStatus_PARTIALLY_RECEIVED";
    case "RECEIVED":
      return "poStatus_RECEIVED";
    case "CANCELLED":
      return "poStatus_CANCELLED";
    default: {
      const _exhaustive: never = tab;
      throw new Error(`Unhandled PurchaseOrderTab: ${_exhaustive}`);
    }
  }
}

/** Prisma predicate for each tab. Composes with the caller's own
 *  garageId + kind/sent filters via `AND: [tabWherePredicate(tab),
 *  ...otherClauses]`. */
export function tabWherePredicate(
  tab: PurchaseOrderTab,
): Prisma.PurchaseOrderWhereInput {
  switch (tab) {
    case "UNSENT_DRAFT":
      return { status: "DRAFT", sends: { none: {} } };
    case "AWAITING_SUPPLIER":
      return { status: "DRAFT", sends: { some: {} } };
    case "ORDERED":
      return { status: "ORDERED" };
    case "PARTIALLY_RECEIVED":
      return { status: "PARTIALLY_RECEIVED" };
    case "RECEIVED":
      return { status: "RECEIVED" };
    case "CANCELLED":
      return { status: "CANCELLED" };
    default: {
      const _exhaustive: never = tab;
      throw new Error(`Unhandled PurchaseOrderTab: ${_exhaustive}`);
    }
  }
}

/** True on the two DRAFT-split tabs. Callers hide the Sent / Not sent
 *  filter pill on those tabs — the tab already encodes the sent axis,
 *  and a contradictory combo (UNSENT_DRAFT + "Sent" pill) would show
 *  an empty page. The pill stays visible on the other four tabs,
 *  where it's a real filter axis ("which Received POs did I never
 *  send?" is a legit question). */
export function tabHasImplicitSentFilter(tab: PurchaseOrderTab): boolean {
  return tab === "UNSENT_DRAFT" || tab === "AWAITING_SUPPLIER";
}

/** URL param round-trip. Encode as kebab-case ("unsent-draft") so the
 *  URL reads as words rather than SNAKE_CASE. */
export function tabToUrlParam(tab: PurchaseOrderTab): string {
  return tab.toLowerCase().replace(/_/g, "-");
}

/** Parse a URL param into a tab. Legacy compat: `?status=draft` (the
 *  pre-split URL shape) maps to UNSENT_DRAFT — the more common
 *  "needs my action" bucket. Unknown values return null so the caller
 *  falls back to the default tab. */
export function urlParamToTab(raw: unknown): PurchaseOrderTab | null {
  if (typeof raw !== "string") return null;
  const upper = raw.toUpperCase().replace(/-/g, "_");
  // Legacy: ?status=draft (single-bucket URL) still lands somewhere
  // reasonable rather than 404-ing to the default. UNSENT_DRAFT is
  // the "what needs my action" bucket that the operator most likely
  // wanted when they bookmarked the old link.
  if (upper === "DRAFT") return "UNSENT_DRAFT";
  const known = new Set<string>(PURCHASE_ORDER_TABS);
  return known.has(upper) ? (upper as PurchaseOrderTab) : null;
}
