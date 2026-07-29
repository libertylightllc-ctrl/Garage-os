# Optimistic-concurrency gap — catalog only

**Status:** CATALOG. Filed 2026-07-30 alongside the narrow
`editPoLineAction` stale-write fix. The narrow fix (see
`src/app/actions/purchasing.ts` — `editPoLineAction`, and the
matching hidden `expectedUpdatedAt` input on the PO detail page's
edit form) closes exactly one write path. This document lists the
other write paths that share the same shape so a future decision
whether to widen has a starting point. **Do not design the wider
fix from this doc.**

## The shape of the class

- A server component reads a row from the DB and renders a form.
- The user types values into inputs seeded from that read.
- A server action receives the form, ignores what the DB currently
  looks like, and writes.
- Two tabs / two humans editing the same row → last write wins, with
  no signal to either party that they overwrote (or were overwritten
  by) the other.

The narrow fix passes the row's `updatedAt` back verbatim in a hidden
input and narrows the `WHERE` on save. A stale timestamp produces
`count === 0` and the action redirects with an error code the page
shows above a re-rendered fresh table.

## Other paths that share the shape

Verified by grep across `src/app/actions/*.ts`; each row is a form
that mutates a record you can also be editing in another tab.
Vulnerability class, not confirmed exploits.

| Action | File | Row it edits | Notes |
| --- | --- | --- | --- |
| `editEstimateLineAction` | `src/app/actions/estimates.ts` | `EstimateLine` | High traffic — advisor prices estimates, cashier converts to invoice. Same "two tabs, last write wins" risk. |
| `updateInvoiceLineAction` | `src/app/actions/billing.ts` | `InvoiceLine` (snapshot) | Cashier edits after estimate approval. Snapshot rules mean a losing writer overwrites amount + VAT calc silently. |
| `editVehicleAction` | `src/app/actions/vehicles.ts` | `Vehicle` | Advisor changes owner name after a resale — hits the "sold-vehicle reassignment" landmine documented in `docs/intake-duplicate-handling-spec.md`. |
| `updatePartAction` | `src/app/actions/inventory.ts` | `Part` | Owner + advisor can both open. reorderLevel + name are the fields with real overlap. |
| `adjustStockAction` | `src/app/actions/inventory.ts` | `Part.stock` | Two adjustments applied to the same stale read = compounding drift. Higher priority than most rows here because the field is quantitative and drifting is silent. |
| `updateJobCardStatusAction` | `src/app/actions/jobs.ts` | `JobCard.status` | State machine constrains transitions, so a stale tab often produces a natural-language error already ("cannot go from APPROVED back to ESTIMATE"). Lower priority. |

## Reasons NOT to widen this fix now

- The narrow fix took ~50 lines of code, 2 i18n keys × 2 locales, no
  schema change. That worked because `PurchaseOrderLine` already
  has `updatedAt` (Prisma `@updatedAt`, ms precision via
  `timestamp(3)`), and the form is a plain server-action submission
  with no client-side optimistic layer to unwind.
- The rows above are not identical. Some have client components with
  `useTransition` or `useOptimistic` state that would need matching
  updates. Some don't have `updatedAt` on the specific field the
  form edits (invoice line VAT recomputation is a whole-invoice
  write). Copy/paste is the wrong shape.
- Real-world concurrency incidents in a single-branch garage are
  rare — two humans editing the same PO line simultaneously is what
  Chrome reproduced. Two humans editing the same estimate line has
  never been reported. Building for the class before the class has a
  second incident is the wrong ordering.

## Reasons to widen (for the future decision)

- Same silent-overwrite risk is present. Any of these rows can be
  the next incident.
- Multi-branch owners (Phase 2) increase the chance of parallel
  edits from different offices.
- `adjustStockAction` in particular is quantitative and cannot
  self-report — the number just becomes wrong.

## If the decision is to widen

1. Rank by field volatility × field consequence — `adjustStockAction`
   and `updateInvoiceLineAction` first.
2. For each: confirm `updatedAt` exists on the exact row the form
   edits, or add one (do NOT reuse a parent's timestamp).
3. Confirm the client component is not painting optimistic success
   before touching the server action; if it is, undo that first.
4. Add tests in the same three-shape pattern as
   `purchasing-isolation.test.ts` (fresh / stale / deleted).

## Related

- `src/app/actions/purchasing.ts` — `editPoLineAction`, the narrow
  fix this doc is a companion to.
- `src/app/owner/purchasing/[id]/page.tsx` — the hidden
  `expectedUpdatedAt` input on the edit form, plus the `stale_line`
  / `line_not_found` banner branches.
- `src/lib/__tests__/purchasing-isolation.test.ts` — the three
  concurrency tests for the narrow path.
