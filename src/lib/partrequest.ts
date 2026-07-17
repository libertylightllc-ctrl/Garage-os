// Part-request loop (Tier 1 #3) — pure, dependency-free rules so the lifecycle
// is exhaustively testable. The DB actions apply these; the state lives in Prisma.

// Single source of truth for the enum: the Prisma-generated
// `PartRequestStatus`. This used to be a hand-written string union that
// could silently drift from the schema (add BACKORDERED to Prisma and
// this file would happily ignore it). Re-export the Prisma type so
// existing importers keep working.
import { PartRequestStatus } from "@/generated/prisma/client";
import { PART_REQUEST_OPEN_STATUSES } from "./part-request-open";
export { PartRequestStatus };

/** Is this request still outstanding (and therefore blocking the job)?
 *  Reads the same OPEN/TERMINAL routing helper the queue page + nav
 *  badges do, so `isOpen` cannot disagree with them. */
export function isOpen(status: PartRequestStatus): boolean {
  return (PART_REQUEST_OPEN_STATUSES as readonly PartRequestStatus[]).includes(status);
}

/** A catalog part is available now if it has enough quantity on hand. */
export function inStock(qtyOnHand: number | null | undefined, qty: number): boolean {
  return typeof qtyOnHand === "number" && qty > 0 && qtyOnHand >= qty;
}

/** A fresh request pauses the job exactly when the part isn't available now. */
export function shouldPauseForRequest(available: boolean): boolean {
  return !available;
}

// Allowed advisor/parts transitions from each status. ARRIVED -> ORDERED is the
// "wrong / late part" path (Tier 2 #10): send it back and re-order.
const TRANSITIONS: Record<PartRequestStatus, PartRequestStatus[]> = {
  REQUESTED: ["ORDERED", "FULFILLED", "CANCELLED"],
  ORDERED: ["ARRIVED", "CANCELLED"],
  ARRIVED: ["FULFILLED", "ORDERED", "CANCELLED"],
  FULFILLED: [],
  CANCELLED: [],
};

export function canTransition(from: PartRequestStatus, to: PartRequestStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Does moving INTO this status consume stock (i.e. the part is handed to the tech)? */
export function consumesStock(to: PartRequestStatus): boolean {
  return to === "FULFILLED";
}

/** Does moving INTO this status restock the catalog (the ordered part arrived)? */
export function restocks(to: PartRequestStatus): boolean {
  return to === "ARRIVED";
}

/**
 * Net stock change for a catalog part on a transition (caller multiplies nothing —
 * pass qty in). Arrival adds; fulfilment consumes; sending an arrived (wrong/late)
 * part back to re-order reverses the earlier receipt.
 */
export function stockDelta(from: PartRequestStatus, to: PartRequestStatus, qty: number): number {
  if (to === "ARRIVED") return qty; // received from supplier
  if (to === "FULFILLED") return -qty; // handed to the technician
  if (from === "ARRIVED" && to === "ORDERED") return -qty; // wrong/late → returned & re-ordered
  return 0;
}

/**
 * After a request changes, may the job auto-resume? Only when it is held
 * specifically for parts AND nothing else is still outstanding. This guarantees
 * a parts-resume can never override an AWAITING_APPROVAL (quote) hold.
 */
export function canResumeFromParts(
  holdReason: string | null | undefined,
  openCount: number,
): boolean {
  return holdReason === "AWAITING_PART" && openCount === 0;
}
