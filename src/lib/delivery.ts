// Delivery stage (Job-Card-Data-Model.md). Pure helpers so the gating + display are testable.

import { REMINDER_TYPES, type ReminderType } from "./reminders";

/** Delivery can only be recorded once the invoice is cut (post-Billing). */
export function canRecordDelivery(status: string): boolean {
  return status === "INVOICED";
}

/**
 * Validate a combined delivery-form payload. Delivery must not be
 * recorded without a maintenance reminder (Workflow-Spec step 16) — this
 * gate exists BOTH client-side (disable button) AND server-side (reject
 * request). Pure so we can unit-test the reject paths without a DB or
 * auth mock.
 *
 * A valid payload has:
 *   - ≥1 reminder type in REMINDER_TYPES (any unknown type is dropped)
 *   - serviceDate parseable as a Date
 *   - mileageOut a non-negative finite number
 */
export type DeliveryFormInput = {
  types: readonly unknown[];
  serviceDate: string;
  mileageOut: number;
};
export type DeliveryFormValid = {
  ok: true;
  types: ReminderType[];
  serviceDate: Date;
  mileageOut: number;
};
export type DeliveryFormInvalid = { ok: false; error: string };

export function validateDeliveryInput(
  input: DeliveryFormInput,
): DeliveryFormValid | DeliveryFormInvalid {
  const types = input.types
    .map((x) => String(x))
    .filter((x): x is ReminderType => (REMINDER_TYPES as string[]).includes(x));
  if (types.length === 0) {
    return { ok: false, error: "Schedule a maintenance reminder before delivering." };
  }
  const raw = String(input.serviceDate ?? "").trim();
  if (!raw) {
    return { ok: false, error: "Enter the service date." };
  }
  const serviceDate = new Date(raw);
  if (Number.isNaN(serviceDate.getTime())) {
    return { ok: false, error: "Enter a valid service date." };
  }
  const mileageOut = cleanMileage(input.mileageOut);
  if (mileageOut === null) {
    return { ok: false, error: "Enter a valid mileage out." };
  }
  return { ok: true, types, serviceDate, mileageOut };
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
