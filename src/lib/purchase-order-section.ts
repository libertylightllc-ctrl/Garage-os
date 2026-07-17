// Routing helpers for the owner purchasing page. Every function below is
// EXHAUSTIVE over the Prisma PurchaseOrderStatus enum via a `never`
// default arm — TypeScript fails the build the moment a new status ships
// in the schema without being routed here. That closes the class of bug
// where a new enum value silently drops rows out of the UI (the exact
// bug that had PARTIALLY_RECEIVED disappearing before this file existed).

import { PurchaseOrderStatus } from "@/generated/prisma/client";
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

/** i18n label key per status. TypeScript blocks the build if a new
 *  status is added without a translation key. */
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

/** Tab order shown on the purchasing page. Derived DIRECTLY from
 *  Object.values(PurchaseOrderStatus) so a new enum value ships with a
 *  tab automatically — no hand-written array to forget updating (the
 *  same class of bug we just fixed one layer down). Prisma preserves
 *  the schema's enum declaration order, which is exactly the
 *  Draft → Ordered → Partly received → Received → Cancelled order the
 *  owner reads left-to-right. */
export const PURCHASE_ORDER_TABS: readonly PurchaseOrderStatus[] =
  Object.values(PurchaseOrderStatus);

/** Default tab when no ?status= is present. ORDERED is the "real work
 *  in flight" bucket — Draft is unsent paperwork, terminal statuses
 *  are read-only, so ORDERED is where the owner most often wants to
 *  land. */
export const DEFAULT_PURCHASE_ORDER_TAB: PurchaseOrderStatus = "ORDERED";

/** URL param round-trip. Encode/decode a status as lowercase-of-enum
 *  ("partially_received"). Anything unknown -> null so the caller can
 *  fall back to the default tab. */
export function statusToUrlParam(status: PurchaseOrderStatus): string {
  return status.toLowerCase();
}
export function urlParamToStatus(raw: unknown): PurchaseOrderStatus | null {
  if (typeof raw !== "string") return null;
  const upper = raw.toUpperCase() as string;
  const known = (Object.values(PurchaseOrderStatus) as string[]).includes(upper);
  return known ? (upper as PurchaseOrderStatus) : null;
}
