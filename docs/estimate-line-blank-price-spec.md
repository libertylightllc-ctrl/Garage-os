# Estimate-line blank unit price — silent zero bug

Follow-up to the Layer 0 PO/RFQ reshape (`layer-0-po-rfq-reshape`, commits
`14c20b5` + `5a3f547`). Same class of bug as the purchasing.ts
`parseMoney` conflation AR identified, but on the customer-facing side
of the workflow — and worse in impact, because these lines end up on
invoices sent to customers rather than quotations sent to suppliers.

**Not fixed on the Layer 0 branch.** Layer 0 is already large and holds
the schema change. This spec is what to build after Layer 0 merges.

## The bug

Three write paths in `src/app/actions/billing.ts` treat a blank
`unitPrice` field as a real zero and write it to the database:

- **`createEstimateLineAction`** — `src/app/actions/billing.ts:194`
  ```ts
  const priceAbs = Math.abs(Number(formData.get("unitPrice") ?? 0));
  ```
  `Number("")` is `0`, `Math.abs(0)` is `0`. A blank input silently
  writes `unitPrice: 0`, `lineTotal: 0` to the new `EstimateLine`.

- **`updateEstimateLinePriceAction`** — `src/app/actions/billing.ts:254`
  Same pattern. Blank inline-edit silently zeroes a line's price.

- **`createEstimateLineAction` (top-up path)** — `src/app/actions/billing.ts:714`
  Same pattern in the second entry point.

- **`updateEstimateLineAction`** — `src/app/actions/billing.ts:310–317`
  Uses `parseLineEditInput` from `src/lib/billing.ts:40`, which does
  `Number(input.unitPrice)` then only rejects `!Number.isFinite(...)`
  and `< 0`. Blank → `0` passes both, `bad-price` never fires.

## Downstream flow — no guard rescues it

The zero propagates end-to-end:

1. **Estimate line** — `unitPrice: 0`, `lineTotal: 0` written to DB.
2. **Estimate total** — `recomputeEstimate` (`billing.ts:138`) sums
   `lineTotals`; the zero contributes zero.
3. **Invoice generation** — `generateInvoiceForJobAction` (around
   `billing.ts:502–558`) copies each estimate line to an `InvoiceLine`
   verbatim (`unitPrice: l.unitPrice, lineTotal: l.lineTotal`), then
   recomputes `subtotal / vatAmount / total` from the merged draft
   lines via `totalsFor()` (`src/lib/billing.ts:71`). The zero line
   is included, contributing nothing.
4. **VAT** — `computeVat(subtotal, UAE_VAT_RATE)` runs on the
   under-counted subtotal. VAT is understated.
5. **Ledger** — `invoiceLedger(subtotal, vatAmount, total)`
   (`src/lib/billing.ts:114`) writes:
   `DR AR (total) / CR Sales (subtotal) / CR VAT Payable (vatAmount)`.
   All three amounts are understated by exactly the missing line's
   proper subtotal + its VAT.

**Net customer impact:** the customer is under-billed by the missing
line's true price + 5% VAT on it. If the affected line was the ONLY
line on the estimate, the invoice total is `AED 0.00` (the UI likely
prevents sending a 0-total invoice, but there is no server guard I
found).

## Detection surface

The estimate + invoice detail pages render each line with its unit
price. A `AED 0.00` row is visible if a human looks. It is not
obvious in the totals summary — the shop sees the summed totals, not
per-line prices, on the dashboard.

## Prod audit — "has this already happened?"

Read-only query to run against the production database with AR's eyes,
in the Supabase SQL Editor, NOT from the app:

```sql
SELECT
  el.id,
  el."estimateId",
  el.kind,
  el.description,
  el.qty,
  el."unitPrice",
  el."lineTotal",
  e."garageId",
  e."jobCardId",
  e.status  AS estimate_status,
  e."updatedAt"
FROM "EstimateLine" el
JOIN "Estimate" e ON e.id = el."estimateId"
WHERE el."unitPrice" = 0
  AND el.kind IN ('LABOR', 'FEE', 'PART')
  -- Filter out warranty/courtesy 0-cost parts:
  AND (el.kind <> 'PART' OR el."partId" IS NULL)
ORDER BY e."updatedAt" DESC;
```

Then the same shape against `InvoiceLine`:

```sql
SELECT
  il.id,
  il."invoiceId",
  il.kind,
  il.description,
  il.qty,
  il."unitPrice",
  il."lineTotal",
  i."garageId",
  i.number  AS invoice_no,
  i.status  AS invoice_status,
  i."issuedAt"
FROM "InvoiceLine" il
JOIN "Invoice" i ON i.id = il."invoiceId"
WHERE il."unitPrice" = 0
  AND il.kind IN ('LABOR', 'FEE', 'PART')
  AND (il.kind <> 'PART' OR il."partId" IS NULL)
ORDER BY i."issuedAt" DESC;
```

Caveats on the filter:

- `kind = 'FEE'` with negative `unitPrice` is a DISCOUNT — genuine
  data, not a silent zero. Query above catches only `unitPrice = 0`,
  so discounts pass through untouched (they have `< 0` prices).
- `kind = 'PART'` with `partId = NULL` is the risky shape here: a
  free-typed part line with no catalogue link. A `PART` line WITH a
  `partId` and `unitPrice = 0` could be a legitimate warranty
  replacement (rare but real per Key Decision #5), so those get
  filtered out. False negatives possible — a warranty-marked line that
  was actually a mistake — but the false-positive rate is worse than
  missing a few edge cases.

## Fix shape (for the follow-up branch)

Same discriminated result AR mandated on the Layer 0 branch:

```ts
type ParsedMoney =
  | { ok: true; value: number | null }  // null = advisor deferred pricing
  | { ok: false };                       // garbage — reject
```

But this raises a spec question that Layer 0 did not have to answer:

> Is "advisor left the price blank" a legitimate DB state for an
> EstimateLine, or must every line have a price at write time?

For the PO/RFQ reshape, the answer is clearly yes — a supplier hasn't
quoted yet. For an estimate line, the parallel case would be: the
advisor added a line and hasn't priced it yet. That could either be:

1. **Allowed** — `EstimateLine.unitPrice` becomes nullable; the
   estimate cannot be sent to the customer until every line is priced
   (an `canApproveEstimate` guard mirroring `canMarkOrdered`).
2. **Not allowed** — a blank line is rejected on write with a clear
   error; the advisor MUST enter a price to save the row.

Both are defensible. Option 1 matches the "AI proposes, human confirms"
posture and reduces mid-flow rework (an advisor can queue up unpriced
lines while chasing quotes internally). Option 2 is simpler and matches
the current mental model (the estimate is what you'd send today).

**AR to decide the shape** before implementation. Both cost the same
in engineering work; the difference is whether we widen the schema.

The immediate CTA in either shape is the same: replace the raw
`Number(formData.get("unitPrice") ?? 0)` and `parseLineEditInput`'s
finite-check-only path with a real discriminated parse. `Number("")`
must not collapse into 0 silently anywhere in `src/app/actions/billing.ts`
or `src/lib/billing.ts`.

## Deliberately not in scope

- `src/app/actions/inventory.ts` — its own `parseMoney` also returns
  `string | null` and treats blank as invalid. Catalogue parts
  genuinely require both cost + sale price to be sellable, so
  rejecting blank is correct behaviour there. Error message could be
  clearer (a blank should say "required" rather than "must be a
  non-negative number") but that's a cosmetic polish, not a data-
  fidelity bug.

- `src/app/actions/billing.ts` currency conversion in receipts,
  refunds, and payment recording. Those code paths already validate
  amounts via explicit checks; the silent-zero pattern is confined to
  estimate/invoice line PRICE inputs.
