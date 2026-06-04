// Part-request loop (Tier 1 #3) — pure, dependency-free rules so the lifecycle
// is exhaustively testable. The DB actions apply these; the state lives in Prisma.

export type PartRequestStatus = "REQUESTED" | "ORDERED" | "ARRIVED" | "FULFILLED" | "CANCELLED";

// Open states still block the job; closed states release it.
const OPEN: PartRequestStatus[] = ["REQUESTED", "ORDERED", "ARRIVED"];

/** Is this request still outstanding (and therefore blocking the job)? */
export function isOpen(status: PartRequestStatus): boolean {
  return OPEN.includes(status);
}

/** A catalog part is available now if it has enough quantity on hand. */
export function inStock(qtyOnHand: number | null | undefined, qty: number): boolean {
  return typeof qtyOnHand === "number" && qty > 0 && qtyOnHand >= qty;
}

/** A fresh request pauses the job exactly when the part isn't available now. */
export function shouldPauseForRequest(available: boolean): boolean {
  return !available;
}

// Allowed advisor/parts transitions from each status.
const TRANSITIONS: Record<PartRequestStatus, PartRequestStatus[]> = {
  REQUESTED: ["ORDERED", "FULFILLED", "CANCELLED"],
  ORDERED: ["ARRIVED", "CANCELLED"],
  ARRIVED: ["FULFILLED", "CANCELLED"],
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
