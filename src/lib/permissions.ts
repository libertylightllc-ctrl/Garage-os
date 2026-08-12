// Who may do what with money. Pure + dependency-free so the rules are testable.
//
// KEY DECISION #5 (AGENTS.md — updated 2026-06-23):
//   ADVISOR creates + prices estimates; CASHIER invoices + collects payment.
//
// The previous architecture had a single PRICING_ROLES = ["CASHIER", "OWNER"]
// gating both estimate AND invoice editing. After observing real shops in
// pilot, the workflow that actually plays out is: the technician finishes
// diagnosis and the ADVISOR — who knows the customer and owns the WhatsApp
// relationship — prices the estimate and sends it. The CASHIER takes over
// once the customer approves, generating the invoice and collecting payment.
//
// So the rules split into two non-overlapping buckets:
//
//   ESTIMATE_CREATE_ROLES  → ADVISOR + OWNER  (create + edit estimate lines)
//   INVOICE_ROLES          → CASHIER + OWNER  (generate invoice, edit lines,
//                                              record payment, advance payment)
//
// OWNER appears in both because small single-person shops have the owner
// doing everything. CASHIER NO LONGER appears in estimate-editing actions —
// any cashier-side UI that calls estimate-create / line-edit will fail
// authorization after this change. The cashier's UI buttons for estimate
// pricing are removed in a follow-up phase; until then they still render
// but their submits 403. (Cashier's invoice + payment work is completely
// unaffected — they remain in INVOICE_ROLES.)

// MASTER (added 2026-07-12) is the owner-created do-everything operational
// role: advisor + tech + cashier under one login. It appears in every
// operational bucket below but never gains owner dashboard/financials.

/** Roles that may create + edit estimate lines / prices. */
export const ESTIMATE_CREATE_ROLES: string[] = ["ADVISOR", "OWNER", "MASTER"];

/** Roles that may generate / edit invoices, record payment, and take advance payments. */
export const INVOICE_ROLES: string[] = ["CASHIER", "OWNER", "MASTER"];

/** Roles that may send an estimate to the customer / record the customer decision. */
export const SEND_ROLES: string[] = ["ADVISOR", "CASHIER", "OWNER", "MASTER"];

/** Can this role create + edit estimate prices? Cashiers explicitly cannot anymore. */
export function canEditEstimate(role: string | null | undefined): boolean {
  return !!role && ESTIMATE_CREATE_ROLES.includes(role);
}

/** Can this role generate / edit invoices, take payment? Advisors explicitly cannot. */
export function canEditInvoice(role: string | null | undefined): boolean {
  return !!role && INVOICE_ROLES.includes(role);
}

/** Can this role send an estimate to the customer? */
export function canSendEstimate(role: string | null | undefined): boolean {
  return !!role && SEND_ROLES.includes(role);
}

/**
 * Margin visibility gate (AR 2026-08-12, profit-reporting Phase 1).
 *
 * Per AR's explicit rule: advisors and owners see cost + margin figures
 * (advisors price + negotiate, so margin has to be visible while they
 * work; owners run the shop and read the reports). Technicians and
 * cashiers must never see cost or margin. And none of it ever appears
 * on a customer-facing document, regardless of who's logged in — the
 * customer-side gate is handled at the customer routes with select:
 * allowlists (see src/lib/__tests__/customer-invoice-line-fields.
 * test.ts), NOT by this helper.
 *
 * MASTER is included because AGENTS.md § MASTER makes it "advisor +
 * tech + cashier under one login" — the advisor half of that is where
 * pricing decisions happen, so the margin has to be visible for
 * MASTER too. Same reason MASTER is in ESTIMATE_CREATE_ROLES above.
 *
 * Every current and future surface that could render cost, markup, or
 * margin — the estimate line editor, the job profit card, the owner
 * period widget, the per-part report — MUST call this helper before
 * rendering the relevant column / row / value. String-grep-friendly
 * name so a code review can find every gate site quickly.
 */
export const MARGIN_VIEW_ROLES: string[] = ["ADVISOR", "OWNER", "MASTER"];

export function canSeeMargin(role: string | null | undefined): boolean {
  return !!role && MARGIN_VIEW_ROLES.includes(role);
}
