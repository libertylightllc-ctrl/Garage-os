# Estimate → Purchase Order — Design & Decisions

**Status:** design locked, not built.
**Owner:** AR.
**Author of this spec:** captured from an investigation on 2026-07-18.

Purpose: on the Purchasing surface, an owner or master enters a **job card
number**, the system finds the right advisor's estimate for that job, shows
its **parts** lines, the owner ticks which parts to include and picks **one
supplier**, and those become a **draft** purchase order.

This document freezes the investigation findings and the locked decisions so
the intent doesn't evaporate between sessions.

---

## 1. Data model — what supports this today

All findings verified against `prisma/schema.prisma` (do NOT re-derive; if
the schema drifts, update this spec).

### 1.1 Estimate lines have a type — filtering "parts only" is trivial

`prisma/schema.prisma` (`LineKind` enum + `EstimateLine`):

```prisma
enum LineKind { LABOR  PART  FEE }

model EstimateLine {
  kind        LineKind       // ← the discriminator
  partId      String?        // ← optional Part link
  part        Part?  @relation(fields: [partId], references: [id])
  description String
  qty         Decimal
  unitPrice   Decimal
  declined    Boolean @default(false)   // customer skipped this item
  ...
}
```

"Parts only" is one clause: `where: { estimateId, kind: "PART" }`.

### 1.2 `EstimateLine.partId` is NULLABLE — inventory link is not guaranteed

Two shapes exist in real data:

- **Linked** (`partId` set): advisor picked from inventory. `line.part.cost`
  is the supplier cost — a perfect PO source.
- **Unlinked** (`partId` null, description only): free-text (e.g. "brake
  sensor"). No inventory record, no cost, no SKU.

`PurchaseOrderLine.partId` is **required**. So unlinked estimate lines
**cannot** flow into a PO line as the schema stands today.

### 1.3 A job has MANY estimates

`JobCard.estimates: Estimate[]` — one-to-many, no uniqueness constraint.
Revisions are the norm (rejected → revise creates additional Estimate rows).

`EstimateStatus`: `DRAFT | SENT | APPROVED | REJECTED`.

### 1.4 No existing estimate → PO linkage anywhere

Confirmed by:
- Grep of `prisma/schema.prisma`: `PurchaseOrder` / `PurchaseOrderLine` have
  no column referencing `Estimate` or `EstimateLine`.
- Grep of `src/app/actions/purchasing.ts`: no estimate lookup or conversion
  logic.
- The `Part.estimateLines` back-reference exists but is just the inverse of
  `EstimateLine.part` — not a PO path.

Truly net-new. No half-baked precedent to reconcile.

---

## 2. Locked decisions

Decisions taken by AR on 2026-07-18. All future work on this feature must
respect these unless AR explicitly reverses.

### 2.1 Unlinked estimate lines are SKIPPED (option "a")

Estimate lines with no `partId` are shown greyed-out in the picker with a
hint like *"no inventory link — add to inventory first"*. Owner has to
create the Part before those lines can be converted.

- **Not option (b)** — no inline "create Part now" mini-form during
  conversion. Keeps this flow single-purpose.
- **Not option (c)** — do NOT loosen the `PurchaseOrderLine.partId`
  schema. That's a real schema decision with blast radius across receiving
  math, isolation tests, and the "PO → inventory" invariant. Reserve it as
  its own future decision, not a rider on this feature.

### 2.2 Estimate selection rule

When multiple estimates exist on a job (revisions), pick in this order:

1. **APPROVED** — the latest by `approvedAt`. Customer said yes to these
   parts.
2. **SENT** — the latest by `sentAt`, only if no APPROVED exists.
3. **Never DRAFT** — draft prices leak internal figures.
4. **Never REJECTED** — customer said no.
5. **No estimate at all** — inline error: *"Job JC-… has no estimate yet.
   Ask the advisor to price it first."*

The chosen estimate MUST be surfaced in the UI (e.g. *"Estimate from
2026-07-14, APPROVED"*) so if the wrong revision is picked the owner sees
it before confirming.

### 2.3 Route & guards

- **New route:** `/owner/purchasing/from-estimate`.
- **Page guard:** `requireAnyRole(["OWNER", "MASTER"])` (via `src/lib/guard.ts`).
- **Action:** `createPoFromEstimateAction(jobCardId, supplierId, lineIds[])`
  in `src/app/actions/purchasing.ts`.
- **Action guard:** `requireOperational()` (via `src/lib/action-guards.ts`).
- **Boundary test:** extend `src/lib/__tests__/master-owner-boundary.test.ts`
  with the new action in `OPERATIONAL_ACTIONS`. Do this in the same commit
  that adds the action — the "opening a page to MASTER means opening its
  actions too" rule in AGENTS.md is what closed this class of bugs.

### 2.4 Entry point — dedicated route, NOT a tab on `/owner/purchasing`

Add a second CTA on `/owner/purchasing` next to "New purchase order":
*"Convert from estimate"* → routes to `/owner/purchasing/from-estimate`.

Not a tab under the status filter — the status tabs carry semantic weight
(DRAFT/ORDERED/RECEIVED); mixing an action pane in there muddies them.

### 2.5 Job-card lookup — typeahead, not a list

- Input: job-card number (e.g. `JC-2026-0001`, backed by
  `JobCard.number: Int?` unique-per-garage).
- Typeahead / autocomplete, garage-scoped.
- Inline preview: vehicle (make/model/plate) + customer name, so the owner
  can confirm the right car before ticking parts.
- Fallback "browse jobs with estimates" link for when the owner doesn't
  know the number.

Not a straight list — shops with hundreds of open jobs would blow up.

### 2.6 Line-selection & pricing rules

- Filter for the picker: `kind: "PART" AND partId IS NOT NULL AND declined = false`.
- `declined` lines are already the customer's "no thanks" — never surface
  them.
- PO line **qty**: from `EstimateLine.qty`.
- PO line **unitCost**: prefill from `Part.cost` (inventory), owner
  editable. **Never** from `EstimateLine.unitPrice` — that's the customer
  charge, not the supplier cost.
- One PO per conversion. One supplier per PO. Owner picks the supplier at
  conversion time (dropdown of active suppliers, garage-scoped).
- PO is created as **DRAFT** so the owner can still add other lines, change
  status manually, etc.

### 2.7 UX surfacing

The conversion screen must show:
- Which estimate was picked (date + status) and let the owner see this
  before confirming.
- The full parts-line preview, grouped:
  - **Selectable** (linked + not declined) — checkbox, prefilled ticked.
  - **Skipped, needs inventory** (no partId) — greyed with "add to
    inventory first" hint + a link to `/owner/inventory`.
  - **Skipped, declined by customer** — greyed with a note (informational
    only, no action).

---

## 3. Preconditions before building

**Do NOT start this feature until:**

1. `86e5cc2` (the MASTER action-guard swap) has been verified by human
   click across all 5 guard families (create PO ✓ already; add line, set
   status, add supplier, add part still pending) and pushed. An unverified
   guard fix sitting under a new feature is how a regression hides.
2. The DB proxy stability issue is separately addressed — the flaky
   `prisma dev start --detach` on Windows has already burned two full
   verify runs. Net-new work deserves a clean environment.
3. AR is fresh — this is a real feature, not a tail-of-session task.

---

## 4. Definition of done (for when we build)

- Route `/owner/purchasing/from-estimate` renders behind the correct guard.
- Job-number typeahead resolves to a JobCard, or a clean "not found".
- Estimate selection rule 2.2 is implemented and the chosen estimate is
  displayed.
- Parts-line picker respects the filter in 2.6 and the three groupings in
  2.7.
- Supplier dropdown is required (garage-scoped, active only).
- `createPoFromEstimateAction` creates a DRAFT PO with lines carrying qty
  from the estimate and `unitCost` prefilled from `Part.cost` (owner
  editable before submit).
- Action is under `requireOperational()`.
- Boundary test extended and green.
- tsc + full suite + human click through the flow all green.

---

## 4b. Known follow-up UX polish — not blocking

Discovered by AR during the MASTER click-pass on 2026-07-18. Logged so it
doesn't evaporate — small, own commit, do NOT rider it into the initial
build.

### "No convertible parts" message conflates three distinct cases

`src/app/owner/purchasing/from-estimate/page.tsx:229-232` renders one
message — `t("noConvertibleParts")` — whenever `filtered.convertible.length
=== 0`. But the empty-convertible set actually has three flavours that
call for different owner action:

1. **Estimate has zero PART lines** (labour-only or advisor still typing).
   Owner action: none — ask the advisor to price the parts.
2. **Estimate has PART lines but all have `partId=NULL`** (free-text
   Moulkia intake — this is the JC-2026-0005 case AR hit). Owner action:
   add them to inventory first, then re-enter the flow. Should include a
   link to `/owner/inventory`.
3. **Estimate has PART lines but all are `declined=true`** (customer
   rejected every part). Owner action: none — the customer said no.

The distinguishing data is already computed: `filtered.skippedNoPartId`
and `filtered.skippedDeclined` sit alongside `filtered.convertible` in
the same `FilteredLines` return, so the branch is trivial.

Fix shape (for the follow-up commit):
- Split the single "noConvertibleParts" branch into three subcases based
  on `skippedNoPartId.length` and `skippedDeclined.length`.
- Three new i18n keys (en + ar): `estimateEmptyParts`,
  `estimateAllUnlinked`, `estimateAllDeclined`.
- Case (2) gets the same `/owner/inventory` link the mixed-skip section
  already has.
- ~30 LOC + i18n keys. No test change beyond covering the branches in
  the existing helper test.

Not urgent — the current single message isn't wrong, just less
actionable. Defer until a natural touch of this file.

---

## 5. Explicitly out of scope

- Any schema change to `PurchaseOrderLine.partId` nullability (option "c"
  above) — future decision, not this feature.
- Inline Part creation during conversion (option "b") — future decision.
- Multi-supplier splits from one estimate — one PO, one supplier, per 2.6.
- Bringing over LABOR or FEE lines — parts only, per 2.6.
- Any linkage between the created PO and its source estimate at the schema
  level (e.g. `PurchaseOrder.sourceEstimateId`). This spec doesn't need
  that for v1; if we want it later, it's an additive migration.
