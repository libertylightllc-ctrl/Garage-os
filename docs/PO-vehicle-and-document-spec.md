# Purchase Order — vehicle-per-line & "PO as document" scope

**Status:** design open. No decision locked. No code written.
**Author of this spec:** captured from the investigation on 2026-07-18.

Purpose: AR asked to add a vehicle field to each PO line ("which car is
this part for?"). The investigation uncovered a bigger gap underneath —
**there is no supplier-facing PO artifact in the app at all today** — which
changes what "vehicle on a line" is even for. This doc freezes the
findings, the two candidate data models, and the workflow questions AR
needs to answer before we build.

---

## 1. The finding that reframes the whole feature

**There is NO supplier-facing PO document in the app today.** Grepped
exhaustively (2026-07-18):

- `/owner/purchasing/[id]` (PO detail) has no `PrintButton`, no
  `SendViaWhatsAppButton`, no share/copy/clipboard function.
- No `/owner/purchasing/[id]/preview` or `/pdf` route — only `page.tsx`.
- `PurchaseOrder.reference` is the *supplier's* quote/reference number
  (their id for us), not our outbound PO number. There is no
  `PurchaseOrder.number` gapless sequence (unlike `Invoice.number`).
- No WhatsApp template exists in `src/lib/wa-templates.ts` for POs.

**The PO detail page is an internal accounting screen.** When the owner
"sends the PO" to the supplier today, they do it out-of-band — a phone
call, a WhatsApp photo of the screen, a personal-email retype. The app
produces zero outbound artifact.

**Why this changes the vehicle question**: "the supplier needs to know the
car" only matters if a document reaches the supplier. Today, none does.
So the vehicle-per-line field is only useful in one of two modes:

- **(a) Internal-only:** owner reads the on-screen PO when parts arrive
  and remembers "these two batteries are for Khalid's Prado, not Mansour's
  Corolla." A UX aid for the owner alone.
- **(b) Part of a real PO-as-document feature:** owner clicks Send or Print;
  the artifact reaching the supplier includes the vehicle context so the
  supplier can etch it on packaging, prioritise correctly, etc.

These are different features. (a) is small. (b) is a Phase-3 purchasing
surface — see §5.

---

## 2. Data model today — no path from a PO line to a vehicle

`prisma/schema.prisma:765-780`:

```prisma
model PurchaseOrderLine {
  id, purchaseOrderId, partId, qty, receivedQty, returnedQty, unitCost,
  createdAt, updatedAt
}
```

And `PurchaseOrder` (`schema.prisma:744-762`):

```prisma
model PurchaseOrder {
  id, garageId, supplierId, status, reference, note,
  orderedAt, receivedAt
  // no jobCardId, no sourceEstimateId, no vehicleId
}
```

**Zero vehicle context anywhere on the PO or its lines.** You could reach a
vehicle by guessing — the same `Part.id` appears on some `EstimateLine`
that lives on a `JobCard` with a `Vehicle` — but it's ambiguous: one Part
lives on many estimates for many cars, and there's no attribution saying
"THIS PO line was for THAT car."

---

## 3. What each PO-creation path knows about a vehicle today

| Path | Route | Knows a vehicle? | Where it comes from |
|---|---|---|---|
| From-estimate | `/owner/purchasing/from-estimate` → `createPoFromEstimateAction` | ✅ Yes | `estimate.jobCard.vehicle` (queried; shown in the "Job" confirmation card) |
| New PO (manual) | `/owner/purchasing/new` → `createPurchaseOrderAction` | ❌ No | Form has supplier, reference, note. Zero vehicle context. |
| Add line (manual) | Form on `/owner/purchasing/[id]` → `addPoLineAction` | ❌ No | Form has partId, qty, unitCost. Zero vehicle context. |

Note: even `createPoFromEstimateAction` *drops* the vehicle at write time.
The action reads the vehicle-aware estimate but writes only the plain PO +
partId lines. The knowledge is thrown away on the floor.

---

## 4. Two candidate models — A and B

Both are additive migrations. Both leave the receiving math untouched
(neither `receivePurchaseOrderAction` nor `returnPurchaseOrderAction` nor
the status recompute at `purchasing.ts:312-323` reads any vehicle field).

### MODEL A — PO is per-car

Schema:
```prisma
model PurchaseOrder {
  jobCardId  String?
  jobCard    JobCard?
}
```
Or `sourceEstimateId String?` for the audit thread "which estimate did
this PO come from" (recommended if we later want to prevent double-
conversion of the same estimate).

Actions touched:
- `createPoFromEstimateAction` — stamp `jobCardId` at write time. Data
  already available.
- `createPurchaseOrderAction` — form gains a job/vehicle picker at PO
  creation. Optional (leave blank for supplier-batch orders).
- `addPoLineAction` — no change. Lines inherit from PO.
- Detail page — one join added, one header line ("Vehicle: Toyota Prado ·
  A 12345 · JC-2026-0001"), line rows unchanged.

**Cost:** 1 migration, ~4 files, ~80 LOC + tests. Small feature.

**Cannot do:** batch-order for many cars in one PO. Owner phoning the
supplier for "5 Battery 70Ah — 2 Prado, 3 Corolla" forces two POs or
one PO with a vehicle field that no longer matches reality.

### MODEL B — PO lines are per-car

Schema:
```prisma
model PurchaseOrderLine {
  jobCardId  String?
  jobCard    JobCard?
}
```

Actions touched:
- `createPoFromEstimateAction` — every line inherits the estimate's
  `jobCard.id` at write.
- `addPoLineAction` — form gains a job/vehicle picker **per line**. See
  §4b for the UX.
- `createPurchaseOrderAction` — unchanged (PO carries no vehicle).
- Detail page — each line row shows its vehicle badge. Blank-vehicle
  lines are legitimate (stock replenishment).

**Cost:** 1 migration, ~4-5 files, ~120 LOC + tests. Slightly bigger than
A because of the per-line picker UX.

**Can do:** the batch-many-cars case. One PO to NAPA for 5 batteries: two
for Prado (`JC-2026-0001`), three for Corolla (`JC-2026-0007`), plus one
blank-vehicle "for stock."

### Comparison

| Dimension | Model A | Model B |
|---|---|---|
| Schema | `PurchaseOrder.jobCardId String?` (or `sourceEstimateId`) | `PurchaseOrderLine.jobCardId String?` |
| Migration size | Same (one nullable column) | Same |
| Manual "New PO" flow | Adds vehicle picker upfront | No change |
| Manual "Add line" flow | No change | Adds per-line vehicle picker |
| Batching for many cars in one PO | ❌ | ✅ |
| Receiving/returns math | Unchanged | Unchanged |
| Ongoing tax | Every PO write must decide the vehicle | Every line write must decide the vehicle |

Neither breaks receiving math. Neither is dramatically bigger than the
other on schema/migration. The real difference is the batching capability
and the UX for "Add line."

### 4b. Model B UX — how does "Add line" know the vehicle?

Two possible shapes:

**B1 — job-picker per line.** The Add-line form gets a "For job (optional)"
field: typeahead of open jobs by number (e.g. `JC-2026-0001 · Toyota Land
Cruiser · Khalid Customer`). Owner picks a job, then picks the Part, qty,
cost. Left blank → the line is a "stock" line (not tied to a car).

Reality check on typeahead: Next.js server components + forms today, no
client-side JS harness for typeahead. Cheaper first cut: a `<select>` with
the last ~30 in-progress jobs on the garage, most recent first, plus a
"Search…" fallback. Grows a scroll problem past ~50 jobs.

Which jobs are eligible? Reasonable answer: JobCards with status in
`{ARRIVED, INSPECTION, ESTIMATE, APPROVED, REPAIR, EXTRA_WORK_AWAITING_APPROVAL}`
— all in-progress. The same picker the technician uses for `PartRequest`
today is reusable.

**B2 — pick job first, then add multiple lines under it.** UI groups
lines by job section on the detail page: owner picks ONE job, adds N
lines within that scope; for a different job, opens a new section. This
is basically Model-A-per-section — line groups aren't a schema concept,
just UI structure. B2 still needs `jobCardId` on the line schema; it's a
UI micro-optimization over B1's per-line picker.

**Recommendation for Model B:** start with **B1** — simplest, no UI
hierarchy. If owners find themselves repeating the same job N times for
one PO, B2 becomes a follow-up UI change without touching schema.

---

## 5. "PO as document" — the bigger question

If AR's real ask is "the supplier needs to know the car for each part",
that's answered by (b) not (a). And (b) is a bigger feature than the
vehicle-per-line field. Fully building it:

### 5.1 What "PO as document" needs

- **A gapless per-garage PO number.** Add `PurchaseOrder.number Int?` with
  `@@unique([garageId, number])`, mirroring `JobCard.number` and
  `Invoice.number`. Stamped on transition to `ORDERED`.
- **A printable / send-friendly render.** New route
  `/owner/purchasing/[id]/preview` (mirror of
  `/estimates/[id]/preview` and `/invoices/[id]/preview`). Garage brand,
  supplier block, delivery-to address, PO number, per-line vehicle badge
  if Model B, footer with TRN.
- **A `PrintButton`** on both preview and the detail page.
- **A WhatsApp send action.** New template in `src/lib/wa-templates.ts`
  (`purchaseOrderMessage`), a `SendViaWhatsAppButton` on the detail page,
  a signed short-URL to the artifact (mirror of the customer estimate
  send flow).
- **Optional but real: a supplier-facing view route.** If the supplier
  opens the WhatsApp link, do they see a public token-signed page (like
  `/c/invoice/[token]`) or do they see nothing and it's just a WA
  message? Two shapes; the current customer-facing pattern favours
  token-signed public routes.
- **Delivery-to address.** Where does the supplier ship it? Today the
  garage has one address (`Garage` model, `Settings` page). If a shop
  has branches, this needs Branch context. That's Phase-2 branches
  territory — deferrable if Phase-1 shops have one branch each.
- **Status transitions the supplier can trigger.** Does clicking the
  link let the supplier mark it "acknowledged" or "shipped"? Or is it
  read-only? Read-only is the safe start.

### 5.2 Scope estimate

Full "PO as document" including WhatsApp send: 2-3 sessions of work.
Print-only (no WhatsApp): 1 session. Internal on-screen vehicle badge only
(Model A or B without documents): the ~80-120 LOC change described in §3.

---

## 6. Decision matrix — questions AR needs to answer

1. **Real workflow — does a real PO ever cover more than one car?**
   - If 90% single-car: **Model A**.
   - If shops batch to save shipping: **Model B**.
   - AR pilots this — the from-estimate flow strongly implies single-car
     is the norm, but pilots may have batched behaviour we haven't seen.

2. **What is the vehicle field FOR?**
   - Owner's memory aid on-screen (internal): pick Model A/B, small
     change, done.
   - Reaches the supplier: builds a bigger "PO as document" feature (§5),
     of which the vehicle field is one small part.

3. **Blank / batch lines allowed in Model B?**
   - Almost certainly yes (stock replenishment is a real case).
   - Decides whether the new column is `String?` or `String NOT NULL`.
   - Recommend nullable.

4. **PO number — do we add `PurchaseOrder.number`?**
   - Independent of A vs B. Only needed if we build the document feature
     or want cross-shop reporting like "PO count YTD."
   - Recommend yes eventually, no rush if we're deferring the document.

5. **`PurchaseOrder.sourceEstimateId` — track the origin?**
   - Cheap, additive. Model A candidate. Also enables "don't double-
     convert the same estimate" future guard.
   - Recommend yes if we go Model A. Optional under Model B.

---

## 7. Recommendation shape

Two coherent paths I can build once AR decides. Not decided yet:

### Path 1 — internal-only, quick win
- **Model A** with `PurchaseOrder.sourceEstimateId String?` (adds origin
  audit thread for free).
- Manual "New PO" gets a vehicle picker (optional).
- PO detail page shows the vehicle in the header.
- **~80 LOC + boundary tests + isolation tests. 1 commit.**
- Vehicle information stays internal; supplier still contacted out of band.
- Zero blast radius on receiving math.

### Path 2 — "PO as document" v1
- **Model B** on line vehicle (nullable).
- Add `PurchaseOrder.number` gapless sequence.
- New `/owner/purchasing/[id]/preview` route.
- `PrintButton` on the detail page.
- WhatsApp send action + template + signed public route.
- **Multi-session, likely 2-3 commits stacked.**
- The supplier receives a real document; vehicle info lands there.

---

## 8. Preconditions before any of this ships

- AR has answered the two-question workflow decision (§6.1, §6.2).
- Feature B from `docs/Estimate-to-PO-Spec.md` is still deferred; if we
  add `sourceEstimateId` here we cover part of what Feature B needed and
  can retire that deferral in the same commit.
- DB proxy stability is a separate task — same environmental issue that
  has bitten test verification all session.

---

## 9. Explicitly out of scope

- No `PurchaseOrder.jobCardId` AND `PurchaseOrder.sourceEstimateId` at the
  same time. Pick one origin field.
- No `PurchaseOrderLine.description` (free-text lines) — that's Option 2
  in the previous non-stock line report and a separate schema decision.
- No supplier-editable public route (v1 is read-only if we build the
  document).
- No branch-aware delivery address (defer until Phase-2 branches lands).
- No `PurchaseOrder.paymentTerms` / dueDate / VAT lines. A PO is not an
  invoice, and this project doesn't process supplier payments — cash /
  bank POS out of band. If we ever add it, that's Phase-4 finance work.
