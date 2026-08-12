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

## Related — one-time part-catalogue cleanup script

`scripts/merge-parts.ts` — never run, kept for the day it is needed.

Built 2026-08-13 after AR found 7 AUTO Parts on Prod's Demo Garage (all
created before 2026-08-02, the day the Layer 1 refactor stopped the
auto-Part-create flow). Real customer garages had none, but the residue
existed for a week between the AUTO-create flow launching and Layer 1
landing, and another tenant could have picked some up in that window.

What it does: takes a JSON input file of merge pairs
(`{ garageId, keepPartId, retirePartId }`), one transaction per pair.
Repoints every FK that references the retiring Part onto the keeper
(5 tables — `JobPart`, `PartRequest`, `EstimateLine`,
`PurchaseOrderLine`, `PartMovement`; `InvoiceLine` deliberately
excluded, it stores a frozen snapshot with no `partId` column), rolls
qty forward, blends cost via a REPLACE-vs-weighted-average rule
mirroring `blendPartCost`, soft-retires the loser (never hard-deletes
— the row stays for audit).

Defaults to `--dry-run`. Refuses to write without an explicit
`--commit` flag. Targets Prod via `./lib/target-prod.mjs`.

When to reach for it: a real customer garage develops two Parts that
represent the same physical product (any origin — AUTO residue, CSV
import duplicate, manual add typo) and one needs to be retired without
losing the history that points at it. Not the Demo Garage AUTO case
below.

Usage: `npx tsx scripts/merge-parts.ts --input <path.json> --dry-run`
then, only after reading the planned effect, `--commit`.

## Demo Garage AUTO-Parts residue (harmless, left in place)

The 2026-08-13 Prod audit found 7 AUTO Parts in the seeded Demo Garage
on Prod, all created 2026-07-25 → 2026-07-27 — before the Layer 1
refactor on 2026-08-02 shut off the auto-Part-create flow. Real
customer garages have none.

State on each: `qtyOnHand = 0`, `cost = 0.00`. No new AUTO Parts have
been minted since Layer 1; the source is fixed. The residue does
nothing but sit in the inventory table with an "Auto" chip.

AR decision (2026-08-13): leave them in place. 28 tables' worth of
deletion + a bespoke reseed script isn't worth removing 7 harmless
rows from a disposable tenant.

**If Demo Garage ever needs to be presentable** (a demo video, a
walkthrough for a pilot, screenshots for marketing), the fix is a
wipe + reseed of Demo Garage — never merge on demo data. The wipe
scope + FK-safe deletion order + preflight count queries were
captured in the 2026-08-13 conversation; retrieve from git history
if needed.
