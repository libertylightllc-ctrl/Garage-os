// Shared helpers around the invoice-level discount feature.
//
// The discount is stored as a single FEE line with a marker
// description and a negative amount, so the existing recompute math
// just-works (subtotal = sum incl. negative discount; VAT applies on
// post-discount subtotal). The marker pattern below identifies
// which lines are managed by the dedicated Discount control vs.
// random fee lines someone added by hand.
//
// This MUST NOT live inside src/app/actions/billing.ts because that
// file has `"use server"` at the top, which restricts exports to
// async functions only. A const export there breaks the entire
// module under Next.js Turbopack ("export X not found"). Keeping
// the regex here lets both the action file (re-imports privately)
// and the invoice page (imports for filtering rows) share one
// source of truth.

export const DISCOUNT_DESCRIPTION_MARKER = /^Discount \(/;
