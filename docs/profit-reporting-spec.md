# Profit reporting — spec + limitations

Owner: AR
Started: 2026-08-12

## Scope

Per-job, per-period, per-part profit reporting for owner + advisor +
master. Cost and margin figures are internal — technicians, cashiers,
and every customer-facing document must not see them. Enforced at the
data layer (RSC `select:` allowlists) and at the render layer
(`canSeeMargin(role)`).

## Cost model — average, not per-unit

**How costs land on invoices today:**

1. `Part.cost` is a per-SKU weighted average, blended on goods receipt
   via `blendPartCost()` (see `src/lib/part-cost-blend.ts`). The blend
   rule: `qtyOnHand <= 0 || current == 0` → REPLACE with received
   cost; otherwise weighted average by qty.
2. `InvoiceLine.unitCost` snapshots `Part.cost` at the moment of
   invoice generation (see `src/lib/invoice-cost-snapshot.ts`). Once
   written it never moves — later receipts affect only future
   invoices.

**The limitation this bakes in.** InvoiceLine.unitCost is the
weighted-average catalog cost at the moment of invoicing. It is NOT
the cost of the specific physical part fitted to the car. If a shop
received a brake pad at 40, sold 8 of the 10 on-hand, then received
another batch at 15, the average drops. A subsequent invoice reads
the new average — not the 40 the shop actually paid for the pad on
that car.

**Concrete example.**
- Day 1: shop holds 0 pads. PO receives 10 @ 40. `Part.cost = 40`.
- Day 5: sold 8 pads at cost=40. Two remain.
- Day 10: PO receives 90 @ 25. Blend: (2·40 + 90·25) / 92 = 25.33.
  `Part.cost = 25.33`.
- Day 12: invoice for a pad. `InvoiceLine.unitCost = 25.33`.
  Profit on this line reads margin against 25.33, even though the
  physical pad may well have been one of the 40-cost batch.

**Why we accept this for Phase 1.** True per-unit costing needs batch
(lot) tracking: every physical unit in stock tagged with the receipt
batch it came from, and FIFO / LIFO / actual-batch selection when
lines dispense from inventory. That is a much larger piece of
work — new `PartMovement` semantics, batch tables, receipt →
consumption linkage, and a UI for it. Deferred.

**How this is communicated.** The per-job and per-period profit cards
(Step 5, Step 6) carry a small footnote: *"Margins use weighted-average
part cost, not per-unit cost."* That way an owner reading "gross
margin 28%" understands the number is an accounting average, not the
literal ratio for the exact pad they fitted.

**Reversibility.** If per-unit costing becomes a priority later,
`InvoiceLine.unitCost` is already the frozen snapshot the reports
read from — the change would happen at the *choose which cost to
freeze* step in `generateInvoiceAction`. The report readers don't
change.

## Coverage discipline

Historical jobs (pre-catalog, pre-labour-rate-set) have no cost data
attached. Profit reports never impute — they either count the job or
skip it. Every rollup shows a **coverage %**: covered / total.
Prominent on the per-period widget (same visual weight as the money
number, not small print).

Historical: **no backfill**. The first jobs to enter the reports are
the ones invoiced after Step 6 lands with a full labour rate set
and a non-zero `Part.cost` on every referenced part.

## Visibility rules (from AGENTS.md, echoed here)

- **See cost + margin:** Advisor, Owner, Master.
- **Cannot see:** Technician, Cashier.
- **Never on customer surfaces:** invoice, estimate, WhatsApp,
  customer PDF — enforced at the DB `select:` allowlist, not just at
  CSS `hidden`. Regression pin at
  `src/lib/__tests__/customer-invoice-line-fields.test.ts`.
