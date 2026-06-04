// Who may do what with money. Pure + dependency-free so the rules are testable.
//
// KEY DECISION #5 (AGENTS.md): the CASHIER sets prices, NOT the advisor. The
// advisor may *send* an estimate to the customer (they own the WhatsApp
// relationship) but can never edit line prices, generate an invoice, or record
// payment. Owner is allowed everywhere as an override (small single-person shops).

/** Roles that may set/edit estimate prices, generate invoices, and record payment. */
export const PRICING_ROLES: string[] = ["CASHIER", "OWNER"];

/** Roles that may send an estimate to the customer / record the customer decision. */
export const SEND_ROLES: string[] = ["ADVISOR", "CASHIER", "OWNER"];

/** Can this role set prices? Advisors explicitly cannot. */
export function canSetPrices(role: string | null | undefined): boolean {
  return !!role && PRICING_ROLES.includes(role);
}

/** Can this role send an estimate to the customer? */
export function canSendEstimate(role: string | null | undefined): boolean {
  return !!role && SEND_ROLES.includes(role);
}
