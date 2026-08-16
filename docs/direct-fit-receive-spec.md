# Direct-fit receive — the two-category model

AR 2026-08-16.

## The problem

The receive flow used to force every unlinked PO line into the
catalogue. Two categories exist in a real garage:

* **Stock parts** — oil, filters, common consumables. Kept on the
  shelf, used across many vehicles, reordered. These belong in the
  catalogue with `qtyOnHand` and a blended `Part.cost`.
* **Direct-fit parts** — a ball joint for a specific Ford F150, a
  timing belt for one repair. Bought for the job, fitted that day,
  never enters stock. Same description as a similar part on another
  car, but a different part number and a different vehicle.

Treating a direct-fit part as a stock part fills the catalogue with
zero-quantity duplicate rows. That is the bug this spec closes.

## The categories at receive time

On receiving an unlinked PO line the operator picks one:

1. **Stock** — link this line to an existing catalogue part, or
   create one on the line-edit form first. Receiving increments
   `Part.qtyOnHand` and blends `Part.cost` (existing behaviour,
   unchanged).
2. **Direct-fit** — no catalogue record. Records the receipt against
   the job and the vehicle, with the supplier's cost and part
   number, so the cost flows to that job's profit. Nothing enters
   stock.

**The default is Direct-fit for every unlinked line.** The system
cannot infer which items a shop keeps on a shelf — both an oil filter
for a Corolla and a ball joint for a Corolla have a vehicle. Direct-fit
is the more common case for most garages, and defaulting that way
means the safe outcome (no catalogue record) happens unless the
operator deliberately chooses otherwise.

**Catalogue-name hint.** When an unlinked line's description
normalises to an existing Part in the shop's catalogue, the receive UI
surfaces a hint — *"You stock a part called Oil Filter — is this the
same? If yes, pick Stock item."* — without changing the default. This
catches genuine stock items the operator would otherwise miss.

## Schema

Two additions, both nullable/additive; no data backfill needed.

### `PurchaseOrderLine.sourceEstimateLineId String?` + relation

Populated by `createPoFromEstimateAction` on every line the from-
estimate flow creates. The receive path reads it to:

* resolve the JobCard via `sourceEstimateLine → estimate → jobCardId`
* decide whether reconciling the estimate cost is safe (checks
  `sourceEstimateLine.estimate.invoice` — see the ordering rule
  below)

Nullable so manually-added PO lines (no estimate origin) still work;
those can only take the stock path today.

### `JobPartReceipt` model

Receipt ledger for the direct-fit path. Written only by
`receivePurchaseOrderAction`. Shape:

```prisma
model JobPartReceipt {
    id                  String   @id @default(cuid())
    jobCardId           String   // FK JobCard (RESTRICT)
    purchaseOrderLineId String   // FK PurchaseOrderLine (CASCADE)
    description         String   // snapshot at receipt time
    qty                 Int
    receivedUnitCost    Decimal  // actual paid per-unit — authoritative for profit
    receivedPartNo      String?  // supplier / manufacturer code, optional
    createdAt           DateTime @default(now())
}
```

`PartMovement` stays stock-only — direct-fit never participates in
stock ledger by definition. `Part` is untouched by the direct-fit
path.

## Read side — profit reporting

No change required. `computeJobProfit()` reads `InvoiceLine.unitCost`
directly, and `resolveInvoiceLineCost()` already falls through to
`EstimateLine.unitCost` for lines with no `partId`. Direct-fit lines
flow through the existing estimate → invoice snapshot path.

The receive-side reconciliation (below) makes sure the EstimateLine
carries the *actual* supplier cost by the time the invoice is
generated.

## Estimate-cost reconciliation

On a direct-fit receive event, if:

* the source `Estimate` has **no invoice yet**, AND
* the received `unitCost` **differs from** the estimate line's
  currently-stored `unitCost` (or the estimate line had no cost),

then the receive action updates `EstimateLine.unitCost` to the
received value. This ensures the eventual invoice snapshot reflects
the actual supplier cost.

The exact rule is pinned in `src/lib/direct-fit-receipt.ts` →
`shouldUpdateEstimateCost()` with unit tests.

## Post-invoice ordering rule (accepted)

**If the invoice is generated BEFORE the direct-fit part arrives,
the invoice's frozen `unitCost` wins. The subsequent receipt does
not rewrite it.** This matches how catalogue-linked lines already
behave — `Part.cost` changes never rewrite closed-invoice profit.

The pattern in real shops is estimate → part arrives → invoice, not
invoice → part arrives, so the edge case is rare. Accepting the rule
keeps the invoice-snapshot invariant simple; a "correct receipt cost"
affordance on a closed invoice can be added later if it ever hurts,
as a scoped void-and-reissue variant.

## JobCard resolution — two-step fallback (AR 2026-08-16)

The direct-fit path needs to know *which JobCard* the receipt
attributes to. Two paths, tried in order:

1. **`sourceEstimateLine` present** (from-estimate happy path) →
   resolve via `sourceEstimateLine.estimate.jobCardId`. Estimate
   writeback is a candidate per the reconciliation rule above.
2. **`vehicleJobNumber` present on the PO line** (manually-added
   line where the operator captured the Job Card number) →
   resolve via `JobCard.findFirst({ garageId, number: vehicleJobNumber })`.
   No estimate writeback (nothing to write back to); `JobPartReceipt`
   is the sole record of the received cost. Profit reporting will
   flag this as an unreconciled receipt (see the coverage rule below).
3. **Neither** → refuse with a clear message: *"This PO line has no
   job attached. Add a job card number on the line and try again,
   or link a catalogue part if it's a stock item."*

## Profit reporting — receipt coverage (AR 2026-08-16)

`computeJobProfit` gained a third input: an array of `JobPartReceipt`
descriptors with a `reconciled` boolean per receipt. Any receipt with
`reconciled=false` nulls out `partsCost / partsProfit / partsMargin`
— same treatment as a missing part cost. AR's principle: *"a number
that's wrong by an unknown amount is worse than no number."*

**Reconciliation rule** (`isReceiptReconciledOnInvoice` in
`src/lib/direct-fit-receipt.ts`) — a receipt is reconciled iff:

1. It has a `sourceEstimateLine` (rules out the manual-PO path).
2. That line's current `unitCost` equals the receipt's
   `receivedUnitCost` to 2dp (proof the writeback ran and hasn't
   been re-edited).
3. The source estimate has an `invoice` row (proof the writeback
   made it into a frozen snapshot).

Any of the three failing → unreconciled. Rule is deliberately strict:
over-claiming a receipt as reconciled would silently understate parts
cost, exactly the failure mode this coverage rule exists to catch.

The profit card renders a coverage line under the parts sub-card
when `receiptsUnreconciled > 0`:

> *"N received part cost(s) aren't captured on the invoice — add
> them to the estimate + reissue the invoice, or record them as
> separate lines."*

## What direct-fit does NOT support today

* **No partial-receipt cost averaging** — each direct-fit receive
  event writes its own `JobPartReceipt` row with the received cost.
  Cross-receipt averaging isn't needed because direct-fit is one-off
  by definition (order-of-1 for a specific vehicle).
* **No automatic invoice-line creation** on a manual-PO receipt —
  the receipt records the supplier-side event; putting the cost on
  the customer's invoice is a separate step (add an estimate line
  and invoice as usual). The profit-card coverage line surfaces
  this gap so the operator can act on it.

Both can be revisited if a real shop hits them. Neither blocks the
common case.

## Files touched

* `prisma/schema.prisma` — the two schema additions
* `prisma/migrations/20260816120000_direct_fit_receipt/` — ALTER +
  CREATE TABLE
* `src/lib/direct-fit-receipt.ts` — pure helper (`parseReceiveMode`,
  `shouldUpdateEstimateCost`) + re-exports the existing normalize/match
  helpers from `estimate-to-po.ts`
* `src/lib/direct-fit-receipt.test.ts` — unit tests for the two
  decision functions
* `src/app/actions/purchasing.ts` — `createPoFromEstimateAction`
  populates `sourceEstimateLineId`; `receivePurchaseOrderAction`
  splits stock vs direct-fit paths inside its transaction
* `src/app/owner/purchasing/[id]/page.tsx` — receive form renders
  `ReceiveModeToggle` under each unlinked line
* `src/components/receive-mode-toggle.tsx` — client component: two
  radios + conditional cost/part-no inputs + catalogue hint
* `src/i18n/config.ts` — labels for the toggle, catalogue hint, en+ar
* `scripts/smoke-cleanup.mjs` — sweeps `JobPartReceipt` before
  `JobCard`
