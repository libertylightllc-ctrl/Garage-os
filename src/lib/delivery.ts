// Delivery stage (Job-Card-Data-Model.md). Pure helpers so the gating + display are testable.

/** Delivery can only be recorded once the invoice is cut (post-Billing). */
export function canRecordDelivery(status: string): boolean {
  return status === "INVOICED";
}

export type DeliveryDisplayStatus = "PENDING" | "DELIVERED" | "CONFIRMED";

/**
 * Three display states the advisor view uses:
 *   - PENDING:   not yet delivered
 *   - DELIVERED: handover recorded, awaiting customer confirmation
 *   - CONFIRMED: customer confirmed collection (signature equivalent)
 */
export function deliveryStatus(
  deliveredAt: Date | null | undefined,
  confirmedAt: Date | null | undefined,
): DeliveryDisplayStatus {
  if (confirmedAt) return "CONFIRMED";
  if (deliveredAt) return "DELIVERED";
  return "PENDING";
}

/** Clean a mileage-out input — must be a non-negative integer. */
export function cleanMileage(n: number): number | null {
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}
