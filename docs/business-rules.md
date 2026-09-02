# Business rules — how garages actually work

Constraints about the real-world flow of a garage that keep getting
violated by design decisions. Reference against every new proposal.
When AR corrects a design decision on business grounds, the correction
lands here.

Related specs:
- `GarageOS-Technical-Spec.md` — buildable contract
- `Workflow-Spec.md` — the 16-step garage flow
- `Estimate-to-PO-Spec.md` — direct-fit vs stock model
- `../AGENTS.md` — session-standing rules that ARE these constraints

---

## 1. Parts come in two kinds — stock and direct-fit

Stock items live on a shelf across many jobs. Oil filter FLT-AIR sits
in the catalogue; qty-on-hand ticks up on receive and down on issue;
its cost is a weighted blend across receipts.

Direct-fit parts are bought for **one specific car** and fitted the
same day. They never touch a shelf. Same description as a stock item
can be a direct-fit for a different vehicle: "Brake pads" for a Land
Cruiser and "Brake pads" for a Corolla are different parts with
different supplier SKUs and different vehicles.

**Direct-fit parts must never create catalogue records.** A catalogue
row implies "this is a thing we stock". Auto-creating one for every
direct-fit purchase pollutes inventory with per-job SKUs, breaks
qty-on-hand accounting, and hides the fact that the shop's real
catalogue is smaller than it looks.

**Common violation shape:** a receive path that upserts on SKU without
first asking "is this stock, or direct-fit?" A PO line without an
explicit direct-fit marker defaults to catalogue on receive.

**Correct shape:** receive routes go through the two-category model.
Direct-fit receipts link the part to the JobCard (via
`sourceEstimateLineId` or `vehicleJobNumber`) and do NOT touch
`Part`. Stock receipts update the catalogue. See
`docs/direct-fit-receive-spec.md`.

---

## 2. Purchase orders are at cost, never sell

The number on a PO is what the shop **pays the supplier**. The
number on an estimate/invoice line is what the **customer pays**.
These are two different amounts on the same physical part —
markup, VAT, and the shop's margin live between them.

**Purchase orders must never carry the customer's selling price.**
A supplier receiving a PO with retail prices sees the shop's margin,
which breaks the negotiation next time. It's also just wrong: the
supplier is invoicing at their price, not the shop's.

**Common violation shape:** convenience conversions ("we already know
the estimate line's unitPrice, use it on the PO") that ship the sell
price to the supplier because it's the value in hand.

**Correct shape:** PO lines carry `unitCost` only. When a PO line
originates from an estimate line, the cost comes from
`EstimateLine.unitCost` (or the catalogue Part.cost) — never
`EstimateLine.unitPrice`. See `Estimate-to-PO-Spec.md`.

---

## 3. Quotation and purchase order are different documents

A quotation (RFQ) is a shop asking a supplier "what do you charge for
this?" The supplier replies with prices. No commitment either way.

A purchase order is a commitment: the shop is buying, the supplier
is expected to fulfil, an invoice will follow.

**Only an explicit action turns one into the other** — the operator
looks at the quoted price and clicks "Mark ordered". The system must
never auto-convert an RFQ to a PO on any state change (supplier reply
lands, price changes, time passes). Auto-conversion commits the shop
to a purchase they never approved.

**Common violation shape:** "if all lines have prices, treat it as a
PO" — a status derivation from data rather than from an operator
action. Sends a commitment the shop never made.

**Correct shape:** RFQ (`PurchaseOrderStatus.DRAFT` with the RFQ
doc kind) stays DRAFT until `markPurchaseOrderOrdered` fires — an
explicit form submission from the operator. Only then does the doc
kind flip to PO and status advance to `ORDERED`. Cross-refs in
`src/lib/po-doc-kind.ts`.

---

## 4. WhatsApp hand-off is not delivery

The app uses `wa.me` deep-links. Clicking Send opens the operator's
WhatsApp with a pre-drafted message. The **operator** taps send in
WhatsApp. Meta returns no delivery signal back to us — we can't
confirm whether the message reached the customer, was read, or was
even sent from the operator's phone.

**We stamp "handed off", not "sent"** — every timestamp on an
outbound customer message means "the operator was handed the wa.me
URL", nothing more. UI wording, database column names, and any
downstream logic must match that honesty. A cheerful ✓ green pill
reading "Sent to the customer" implies delivery we don't have.

**Common violation shape:** columns and copy that read "sentAt",
"deliveredAt", "sent to customer" — inherited from a world where
we controlled the message pipeline. Also: post-send flows that
assume the customer received it and try to nudge/remind based on
elapsed time.

**Correct shape:** hand-off timestamps + warning-yellow "handed off
at" pills. Any delivery-dependent behaviour (auto-reminders, "did
they read it" checks) waits for the Meta Cloud API commit — see
Key Decision #3 in `../AGENTS.md`. Wording lives in
`src/lib/wa.ts` + i18n keys under `estimateSentAt` / etc.

---

## 5. Blank and zero are different facts

A blank price field is "the advisor hasn't priced this yet." A
zero price is "the advisor explicitly says this line costs nothing"
(courtesy, warranty, comp'd labour). Silently collapsing blank to
zero — the `Number("") === 0` trap — flows into invoice subtotal,
VAT computation, and the filed FTA return. Under-billing plus VAT
understatement is a class of harm that can't be caught by looking
at a summed total.

**The two facts must remain distinguishable at every write
boundary.** A blank submission is rejected. An explicit "0" typed
by the operator is accepted. Pre-filling "0" into a field is a bug
even if the field is `required` — `required` doesn't fire on
non-empty "0".

**Common violation shape:** `Number(formData.get("x") ?? 0)`, or
`x || 0`, or pre-filling "0.00" from a catalogue lookup, or
letting a picker drop "0" into a monetary field.

**Correct shape:** `parseMoney()` in `src/lib/billing.ts` — returns
`{ok: true, value}` or `{ok: false, error: "required" | ...}`.
Blank always fails. Pre-fills leave the field empty when the source
value is 0/null. Every write path routes through the helper.
Pinned by the test at `src/lib/billing.test.ts` "BLANK price is
rejected — was silently 0".

Related rule — the exits also gate: `sendEstimateToCustomerAction`
and `generateInvoiceAction` refuse an estimate/invoice that contains
any non-declined PART line at 0.00, unless the operator confirms
per document. See `findZeroPricedPartLines()` and the
`?formError=zero-part-lines-*` redirect flow. Pre-flight warning +
`⚠ No price` chips on both estimate pages surface the state before
the operator clicks (see the estimate/[id] and preview page).

---

## 6. Profit is either right, or it says it doesn't know

A per-invoice profit number is either **correct** or it is **absent
with a reason**. Never show a computed number derived from
incomplete data — a total that pretends it's the truth when a cost
input is missing or unreconciled tells the shop the wrong thing at
the exact moment they'd act on it (pricing a similar job, deciding
whether to keep a supplier, forecasting).

Missing inputs are common in this domain: a PO landed with no
receive yet, a receipt sits unreconciled against the invoice line,
a direct-fit line was never linked to its receipt. Each is a
legitimate mid-flow state — the profit view must SHOW that state,
not paper over it with a "best guess" number.

**Common violation shape:** "if we don't have `receivedUnitCost`,
fall back to the estimate's `unitCost`" or "if the receipt hasn't
landed, use `Part.cost` as a proxy". Any fallback that turns
missing data into a number is the bug — the number will look
correct, be wrong in a way no one can spot, and get used.

Also violating: a receipt that came in at a different price than the
line's `unitCost` silently overriding profit to zero / null / negative
without saying why. Nulling out on any-mismatch is the mirror image
of the fallback shape: it hides information the shop needs.

**Correct shape:** the profit card renders three states, distinctly.
Number when we have all inputs. Dash + explicit "unlinked receipt"
/ "no receipt yet" / "PO outstanding" label when a component is
absent. Number + warning delta when a receipt disagrees with the
line's cost — the number stands, the disagreement is called out
so the shop can decide which is right. See
`compareReceiptToInvoice()` and the profit-card render for the
three-state pattern (commit `0fcfb01`, INV-2026-0048).

---

## 7. Production write paths never fabricate

Production paths that write to permanent records must not fabricate.
A "simulate a customer message" form in the operator UI produces
rows in the WhatsApp history that no customer sent; a "seed a fake
invoice" button in production writes to the invoice-number sequence
that VAT audits depend on. Test/simulate paths belong in scripts —
kept in `scripts/` or in a staging-only path a real advisor cannot
reach — not in the surfaces staff use every day.

**Why the discipline is strict**: fabricated rows in a
permanent record are indistinguishable from real ones after the
fact. In a dispute (VAT audit, insurance claim, customer complaint,
receipt lookup) the shop cannot prove which speech / row was fake
without a marker. Even with a marker, the sequence is polluted —
gapless-invoice regulations don't accept "row 43 was a test".

**Common violation shape**: "Dev/testing without Meta" or "Simulate
a customer message" panels that sit alongside real staff actions on
a prod-reachable page. Comments in code that read `// Dev:` are the
usual smell. If it's dev, it doesn't ship. If it ships, it isn't
dev — treat it as a production feature and design it with the same
audit + permissions discipline.

**Correct shape**: fabrication paths live under `scripts/` and use
the `target-prod.mjs` / `target-local.mjs` opt-in wrappers — the
operator opens a terminal, not a browser. If a "test conversation"
flow becomes a genuine product need, it lives on a staging-only
surface with a distinct role gate, distinct row markers on write
(rows carry a `simulated` boolean forever), and distinct visual
treatment on read (an audit reader sees "(SIMULATED)" on every such
row for its lifetime). See `WhatsAppMessage.simulated` and the
2026-08-19 chat-tools deletion.

## 8. Stale reads look like writes

When a persisted field appears to have been silently wiped and no
writer in the audit can be shown to touch it, the read side is the
next place to look — not more writer auditing. Browser cache, Next.js
RSC caches, service worker shells, Vercel Data Cache, and stale
client bundles across a deploy all produce the same user-visible
symptom as a real wipe: the page shows the "before" state after a
"nothing-related" save. Both classes deserve the same first move
whenever a report comes in — a direct DB read of the row in
question, before any code investigation.

**Common violation shape**: `field X got wiped when I saved unrelated
field Y` reports opened repeatedly. Each round audits the writers
again and finds nothing. Reports keep coming because the underlying
diagnosis — assumed to be a writer bug — never gets ruled out at the
DB. A direct query would have closed it the first time.

**Correct shape**: on the first report, before touching code, an
operator script reads the row via `import "./lib/target-prod.mjs";
prisma.<table>.findMany({select:{id:true, ...suspect fields...}})`
and reports the actual stored value. If the DB agrees with the "old"
state the user saw, the writers are innocent — investigate render /
cache / bundle. If the DB disagrees, the writer audit is the right
path.

**Closed instance — `Garage.defaultLang`** (2026-08-25). Reported
wiped five times. All five were stale-page reads from the browser
session, confirmed on the fifth report by a direct read that showed
Demo Garage still had `defaultLang = 'ar'` and the just-saved
`defaultPaymentTerms` alongside it, both updated within seconds of
each other. Full writer audit: only `updateGarageDefaultLangAction`
at `src/app/actions/settings.ts` writes the column; no Prisma
middleware, no DB triggers, additive-only migration. Do not
re-audit. If the report resurfaces, read the row first.

**Closed instance — `Garage.estimateTerms` + `invoiceTerms`
"nothing prints on the doc"** (2026-08-25). Reported three times.
Root cause was a variant of the same class in the UI, not the DB:
the Settings textarea rendered
`defaultValue={garage?.estimateTerms ?? seededSampleClauses}` so a
shop opening Settings for the first time saw a fully-populated
textarea that looked saved. The prefill was visually
indistinguishable from a real saved value. Users saw "populated
fields" and assumed the terms were live — but the DB column
stayed null and the print surface (`{garage.estimateTerms ? ... :
null}`) correctly rendered nothing. The direct read via
`scripts/probe-prod-terms.mts` returned `NULL` on every prod
garage across both columns; that's what closed it.

**Rule for suggested/sample defaults in a form**: never render an
unsaved suggestion as the field's value. Either use the HTML
`placeholder` attribute (which greys out and never submits) or
put the sample in a distinct "not yet saved" affordance with an
explicit Adopt button that writes it. If a field's default is
whatever the last operator saved, no fallback text belongs in
`defaultValue`. The fix pattern is in `src/app/settings/page.tsx`
around the two terms sections — a yellow-outlined "Suggested
wording (not yet saved)" card holds the sample plus a
one-click Adopt form; the textarea itself only ever renders the
shop's actually-saved wording.

---

## 9. companyGarageIds does not verify ownership

The multi-branch helper at `src/lib/branches.ts` — `companyGarageIds(garageId)` — walks the `Garage.branchOfId` self-relation. It reads the input garage's `branchOfId`, resolves the company root as `branchOfId ?? id`, and returns `[root, ...children where branchOfId === root]`. There is no ownership check anywhere in that path.

Every caller today is safe **by convention, not enforcement**. The convention is that OWNER accounts get created on the company root garage by the sign-up flow. Given that, walking up via `branchOfId` and back down to siblings stays inside the caller's own tree. That's what keeps `/owner` (the dashboard, the money band, Copilot's aggregated queries, `listBranches`, and everything downstream of `gids`) from leaking data.

**Two latent risks** the next feature that touches company structure needs to plug:

- **OWNER account placed on a branch garage.** If a future franchisee model lets one OWNER own just one branch — not the whole company — `companyGarageIds` climbs to the root and sweeps every sibling. The franchisee sees revenue, unpaid AR, tech productivity, and payroll for branches they don't own. Plug: enforce at the walker (accept only garageIds whose owner-of-record is the caller) or gate at the callers.

- **Branch hierarchy deeper than one level.** `branchOfId` is a self-relation, so `branchOf.branchOf` is expressible in the schema even though no code creates it today. The walker looks one level up and one level down only. Any grandchild garage silently falls out of the aggregation — nobody sees its numbers, nobody gets an error. Under-scoping is quieter than over-sharing but still wrong. Plug: recursive walk (`WITH RECURSIVE` CTE or Prisma-side traversal until fixpoint), or a hard rule at branch creation that rejects `branchOfId` on any garage that is already a branch.

**Rule for the fix:** neither risk should be closed in isolation. The moment either becomes real (franchisee sign-up flow, sub-branch creation), audit **every** call site of `companyGarageIds` and `scopeWhere` — `/owner` dashboard tiles, Copilot, `/owner/billing`, `/owner/staff`, `/owner/analytics`, the ledger reports — and either add an ownership check inside `companyGarageIds` (preferred, single point of enforcement) or refactor callers to pass an explicitly-authorized garageId list.

**Common violation shape**: shipping the franchisee model with `companyGarageIds` unchanged, or deepening the branch hierarchy with the walker unchanged, and testing only the happy path (one franchisee on one branch of a single-level tree). The bug shows up when a franchisee has ambient access to sibling branch data on any page that aggregates by `gids`, or when the owner of a deep hierarchy notices their P&L numbers stopped rolling up.

---

## 10. Payables is accrual on the supplier side, with named gaps

Full accrual, per AR 2026-08-30: goods receipt posts a liability (`DR Inventory + DR VAT-Input / CR AP`) inside the same transaction as the stock movement. Every SupplierBill exists because a receive event created it — there is no "enter a bill" step, no draft bill. What the shop physically received is what the shop legally owes.

**Rollout gate.** Every garage ships with `Garage.payablesEnabled = false`. The receive path when the flag is off is byte-identical to what shipped before the Payables phase — zero risk to existing shops. Enable per garage after a pilot receive verifies the ledger balances. Rollback is the flag flip; existing bills stay, new receives skip.

**Ledger shape on receive:**
```
DR Inventory      subtotal
DR VAT Recoverable vatAmount          [omitted when vat = 0]
CR Accounts Payable subtotal + vat
sourceType="SUPPLIER_BILL", sourceId=bill.id
```

**Ledger shape on payment (per allocation, one pair per allocated bill):**
```
DR Accounts Payable  allocation.amount
CR Cash/Bank         allocation.amount
sourceType="SUPPLIER_PAYMENT_ALLOCATION", sourceId=allocation.id
```

**Ledger shape on bill void:**
```
DR Accounts Payable   total
CR Inventory          subtotal
CR VAT Recoverable    vatAmount   [when vat > 0]
sourceType="SUPPLIER_BILL_ADJUSTMENT", sourceId=bill.id
```

Distinct `sourceType='SUPPLIER_BILL_ADJUSTMENT'` (never overloading `SUPPLIER_BILL`) so a future returns / credit-note flow can be counted separately at ledger-report time. Same discipline as `INVOICE_VOID` on the customer side.

**Direct-fit lines don't post to AP.** A direct-fit receive delivers parts straight to a customer's job (`JobPartReceipt`); the parts never enter Inventory. If we booked `DR Inventory` for them, the account would misstate physical stock, and C4's future COGS post would double-count the cost via `InvoiceLine.unitCost`. So the auto-calc subtotal counts stock lines only. If a supplier bill genuinely covers both stock AND direct-fit from one PO, the operator uses `billSubtotal` on the receive form to reconcile — that's a real-world exception, not something the app guesses at.

**Aging clocks from `billDate`, not `receivedAt`.** UAE convention is Net 30 from invoice date. A supplier who dated their tax invoice last Tuesday ages against last Tuesday even if the parts arrived today. Captured on the receive form (label: "Date printed on the supplier's tax invoice"), defaults to today for the reflex case, operator adjusts when the paper differs.

**No on-account balances.** Every SupplierPayment must allocate its full amount across one or more open bills. Sum-of-allocations must equal payment amount — enforced in `recordSupplierPaymentAction`, refused with a clear message before write. A lump-sum payment against three bills creates three allocation rows summing to the payment amount, not one unallocated blob the operator has to reconcile later. This is the class of thing that turns "how much does this supplier owe me" into unanswerable.

**Void discipline (bills):** a SupplierBill with any allocated payments is hard-blocked from voiding at the action layer. The refusal names each payment (date, method, amount) so the operator finds and reverses them first. Correction path for a paid-and-mis-received bill: supplier issues a credit note, shop records it (compensating negative-amount bill — not yet wired; the refusal message is honest about the current gap).

**Delete discipline (rows):** DB triggers block DELETE on `SupplierBill`, `SupplierPayment`, and `SupplierPaymentAllocation` — same class as the 2026-08-19 78-orphan-Payment guard extension. A SQL-editor DELETE writes an audit row and RAISEs; a session that genuinely needs to delete sets a per-tx `app.allow_supplier_*_delete='true'` flag and captures a note. The app never exposes a delete action for any of these tables. Correction path is void or compensating entry, never delete.

**Common violation shape:** "add a delete action for the operator, they know what they're doing" — this repeats the exact class we spent the 2026-08-19 audit closing. Every delete on a ledger-writing row is a leak vector. If the operator needs to correct an amount, they void the wrong bill and re-receive, or record a compensating payment. Never a delete.

### C4 SHIPPED (AR 2026-09-02) — COGS at invoice, per-garage flag

Every generated invoice with `Garage.cogsEnabled = true` posts a matching COGS pair inside the same transaction as the invoice's AR/Sales/VAT ledger:

```
DR Cost of Goods Sold   SUM(PART qty × InvoiceLine.unitCost)
CR Inventory            SUM(PART qty × InvoiceLine.unitCost)
sourceType="INVOICE_COGS", sourceId=invoice.id
```

Reads the **frozen** `InvoiceLine.unitCost` snapshot, not live `Part.cost` — that snapshot was taken at invoice-generation time via `resolveLineCost` and is what the shop actually paid (or the advisor's typed cost, for free-text lines). See `src/lib/invoice-cost-snapshot.ts` for the rule the snapshot follows.

**All-or-nothing per invoice.** If any PART line has `unitCost = null`, the whole COGS post is skipped. Same "don't fake data" discipline as rule 12 (VAT-on-expenses). Consequence: the invoice's revenue lands in the ledger with no matching COGS, and the P&L classifies that revenue as gross margin — visible + honest, not silently wrong. Pre-C4 invoices with unpopulated `unitCost` fall into this bucket permanently.

**Void reverses.** `voidInvoiceAction` posts `DR Inventory / CR COGS = original SUM` under `sourceType="INVOICE_COGS_ADJUSTMENT"` when the void'd invoice had a COGS pair. Same discipline as `INVOICE_VOID` (customer side) and `SUPPLIER_BILL_ADJUSTMENT` (supplier side) — reversing pairs never overload the original sourceType so they stay countable at ledger-report time.

**Recompute replaces, doesn't append.** `recomputeInvoice` (fires on every editable-invoice line change) deletes the existing COGS pair and re-posts fresh. Three qty edits still leave one pair, not three. Pinned by test `src/lib/__tests__/invoice-cogs.test.ts`.

**Labour is NOT COGS.** LABOR / FEE / DISCOUNT lines are excluded from the COGS SUM even though they carry a `lineTotal` on the invoice. Labour on a repair job is a delivered service, not a cost of goods — its counterpart on the P&L is technician salary (an expense, rule 12), captured separately. Booking labour revenue against a labour-COGS row double-counts the same wages. Gross margin excludes labour cost entirely; net margin subtracts salary via the P&L Salaries line.

**Rollout gate.** Every garage ships with `Garage.cogsEnabled = false`. Same shape as `payablesEnabled` — enable per garage after a proof invoice verifies the ledger balances. Rollback is the flag flip; existing COGS ledger rows stay (that's the whole point of a ledger). Demo Garage flipped on 2026-09-02 and holds a proof invoice `INV-2026-0061` = DR 80 / CR 80 for the "2 × 40" arithmetic case.

**Cutover invariant.** Invoices generated before `cogsEnabled` was flipped for a garage stay permanently uncosted — no back-fill script, no retroactive re-post. The ledger tells the honest story of what the software knew when the invoice landed. A shop's P&L for a period spanning the cutover date will show a partial COGS line (only post-cutover invoices contribute); this shows up in E3 coverage notes as "N of M invoices costed."

### Known gaps (revisit triggers named)

**No opening-inventory backfill.** When a garage flips `payablesEnabled` and `cogsEnabled` for the first time, existing stock has no ledger presence — the first invoice that sells pre-cutover stock consumes Inventory without a matching pre-cutover receive, driving Inventory **negative** in the ledger. Chosen intentionally per AR 2026-08-30: honest arithmetic over a fabricated opening balance. If a shop enables both flags AND then reads their balance sheet, expect the wash. Correction path: script a one-time `DR Inventory / CR Opening Balance Equity` = `SUM(Part.qtyOnHand × Part.cost)` per garage at cutover.

**Supplier payment void action doesn't exist.** In MVP a supplier payment cannot be undone. Correction = compensating payment (record a new payment for a negative amount against the same bill — actually rejected by the action's positive-amount validation, so the real MVP correction path is: contact supplier for credit note, then record it as a negative-amount SupplierBill, which itself isn't wired either). Named because the bill-void refusal message points at "reverse the payment first" but the action doesn't exist yet.

**Common violation shape (for both gaps):** enable Payables + COGS on a garage with significant existing inventory without the opening-balance backfill. Ship the supplier-payment-void action without also shipping the negative-bill / credit-note flow it enables. Each has a clear trigger — don't preempt either.

---

## 11. Stranded purchase orders — close, don't reverse (design, unbuilt)

**Status: designed, not built.** The build trigger is a real shop reaching a stranded PO in production. As of 2026-08-30 (Refined-A destination invariant on `addPoLineAction` + `setPoStatusAction`), no new PO can reach this state — every ORDERED line must have a receive destination (partId, sourceEstimateLineId, or vehicleJobNumber). The only known stranded PO is `PO-SMOKE-001` on demo-garage, a CI smoke-test fixture. Building the recovery flow now is solving a problem the invariant just eliminated. Section preserved so if a real shop ever hits this, the design is ready and the implementation is roughly one hour.

**The state that needs recovery.** A PO reaches PARTIALLY_RECEIVED with a line that:
- has zero received qty, AND
- has no `partId` (no stock destination), AND
- has no `sourceEstimateLineId` and no `vehicleJobNumber` (no direct-fit destination).

Receive refuses it (direct-fit needs a job, stock needs a Part). Cancel refuses it (`setPoStatusAction` refuses CANCELLED on PARTIALLY_RECEIVED). Line edit / add / remove refuse it (DRAFT-only). The PO is stranded — no in-app path forward.

**The recovery pattern: close the PO, don't try to reverse it.**

**Status name: `CLOSED`, not `VOID`.** VOID implies reversal. Nothing here reverses — the received goods are on the shelf (or in a customer's car via direct-fit), the SupplierBill for them stands, the ledger entries stand, any payment allocations against the bill stand. "Closed" is honest: this PO can accept no more receiving, everything already received keeps its state. VOID rejected on those grounds.

**What CLOSED changes:**
- `PurchaseOrder.status` → `CLOSED`. Terminal.
- No future receive / add-line / edit-line / remove-line accepted. Same locks as CANCELLED / RECEIVED.
- Outstanding qty on every line becomes dead — the unreceived portion (whether 4 of 10 or the full 2 of 2 on a stranded line) is dropped from the operator's view of "what's still coming."

**What CLOSED does NOT touch:**
- `PartMovement` rows for prior receives — stay (audit trail).
- `Part.qtyOnHand` — stays (parts on the shelf don't move because the PO closes).
- `JobPartReceipt` rows for direct-fit prior receives — stay.
- `SupplierBill` rows created from those receives — stand. Every one keeps its `purchaseOrderId` link to the (now CLOSED) parent — the paper trail survives.
- `LedgerEntry` rows from the bill (`DR Inventory + DR VAT-Input / CR AP`) — stand.
- `SupplierPaymentAllocation` rows against those bills — stand.

**No ledger writes at close time.** There's nothing to reverse. Everything posted was posted for something that actually happened (goods arrived, bill was raised, maybe payment allocated). What DIDN'T happen (the outstanding qty) was never posted — so no rows to undo. This is why "close" is honest and "void" would be misleading.

**Reissue is out of scope.** A shop that still wants the outstanding parts creates a fresh PO for them. That's what they'd do anyway. Auto-creating a PO from a closed one is a convenience for a case that no longer occurs post-Refined-A; rejected.

**Implementation sketch (when the trigger fires):**
- Schema: `ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'CLOSED';` — one-line migration, non-destructive (Postgres allows enum extension without dropping).
- Action: `closePurchaseOrderAction(formData)` — `requireOperational` (OWNER + MASTER). Refuses on DRAFT (use cancel), RECEIVED (nothing outstanding), CANCELLED, CLOSED. Accepts ORDERED, PARTIALLY_RECEIVED. Sets `status = CLOSED`. No ledger writes. Add to `OPERATIONAL_ACTIONS` in [master-owner-boundary.test.ts](src/lib/__tests__/master-owner-boundary.test.ts).
- UI: "Close this PO" button on the PO detail page when status ∈ {ORDERED, PARTIALLY_RECEIVED}. Confirmation copy: "Close this PO? Received lines, their bill, and any payments stand — nothing reverses. N unreceived lines will be dropped. This can't be undone."
- Tab: `CLOSED` as its own tab in `PURCHASE_ORDER_TABS` — same "counter deserves its own tab" reasoning that added Partly-received. Section = CLOSED (terminal).
- `poDocKind`: CLOSED always has `orderedAt` set (only ORDERED/PARTIALLY_RECEIVED can be closed) → PO doc kind.
- Tests: rejects on unallowed statuses; sets CLOSED on allowed statuses; PartMovement + Part.qtyOnHand + SupplierBill + LedgerEntry + SupplierPaymentAllocation counts UNCHANGED before/after close.

**Trigger for building:** the first real shop (not a fixture, not a smoke test) reaches a PO stranded in a way that Refined A didn't prevent. Possible vectors: a schema migration that lets a line drop its destination post-order, a hydrated flow that creates lines without checking, direct SQL. If none of those happen, this rule stays theoretical and the enum + action stay unbuilt.

**Common violation shape:** building this recovery flow proactively "just in case," then discovering a year later the CLOSED status has never been used and nobody remembers the semantics. Wait for a real trigger. The spec above is the whole design; when the trigger comes, ship it in one commit.

---

## 12. Expenses are direct-posting, void-not-delete, VAT deferred

Money spent that isn't parts — rent, salaries, utilities, tools, marketing, bank charges, office supplies, repairs & maintenance, professional fees, motor-vehicle, and a catch-all. Recorded as a cash-out event, not as a liability awaiting payment. Payables handles the "we owe the supplier" flow; expenses handle "money already left the shop."

**Direct posting.** Every `Expense` row writes one balanced ledger pair on record, inside the same tx as the row itself:
```
DR <expense account>   amount
CR Cash/Bank           amount
sourceType='EXPENSE', sourceId=expense.id
```

No AP intermediary, no accrual step, no "record the bill, pay it later" workflow. If a shop wants to track an unpaid supplier bill, that's Payables and it already exists. An expense IS the payment.

**One `sourceType='EXPENSE'` on every ledger row related to an expense.** Category (11-value enum: `RENT` / `SALARIES` / `UTILITIES` / `TOOLS` / `VEHICLE` / `MARKETING` / `BANK_CHARGES` / `OFFICE` / `REPAIRS_MAINT` / `PROF_FEES` / `MISC`) lives on the `Expense` row, not in `sourceType`. Same principle as the customer-side single `INVOICE` sourceType with detail on the line — makes ledger queries simpler than 11 sourceTypes for what is conceptually one event class.

**11 expense accounts on the ledger** (`ACCOUNTS.EXP_*` in `src/lib/billing.ts`), one per category, all debit-normal. `ACCOUNT_TYPES` registry classifies each as EXPENSE alongside the pre-existing `COGS`. E5's trial balance / P&L / balance sheet reads the registry directly — no naming-convention magic, no special-casing for new expense categories.

**Void, never delete.** Corrections happen via `voidExpenseAction` which:
- Sets `Expense.status='VOID'`, and
- Posts a reversing pair `DR Cash/Bank / CR <expense account>` under the same `sourceType='EXPENSE'` + `sourceId`.

Net across both pairs = 0 on every account. The original record stays in the DB (audit) and stays visible in the UI marked "Void" with a strikethrough amount. The detail page shows a "Net per account" footer once voided, confirming every account netted with a green ✓.

**Delete-guard trigger** (E1b migration): DB refuses `DELETE FROM "Expense"` without a per-tx session flag `app.allow_expense_delete='true'`. Every attempt writes to `ExpenseDeleteAudit`. Same class as the six existing ledger-source delete-guards (Invoice / Payment / AdvancePayment / SupplierBill / SupplierPayment / SupplierPaymentAllocation). App exposes no delete action; correction is void + re-record.

**Common violation shape:** "add a delete-expense button, operators complain about not being able to fix mistakes fast enough." Deletes on ledger-writing rows are the exact class we spent the 2026-08-19 audit closing (78 orphaned Payment rows) and every subsequent phase locking down (Payables C2 / C5, this rule). The correction path is void + new expense with the right details. The strikethrough in the history table and the reversing pair in the ledger are the honest record.

### E1f SHIPPED (AR 2026-09-02) — VAT split on expenses

The `Expense` schema now carries three money columns: `total` (was `amount`), `subtotal`, and `vatAmount`. Every `recordExpenseAction` posts the three-row shape when VAT is present, two-row shape when it isn't:

```
DR <expense account>   subtotal
DR VAT Recoverable     vatAmount   [omitted when vatAmount = 0]
CR Cash/Bank           total
sourceType='EXPENSE', sourceId=expense.id
```

Void mirrors — reverses the VAT row too when the original had one; skipped when it didn't. Same discipline as C4a's `INVOICE_COGS_ADJUSTMENT` reversal.

**VAT defaults to zero on the form — not auto-calc from `Garage.vatRate`.** AR 2026-09-02: auto-calc would silently claim reclaimable input VAT on SALARIES (payroll is out of scope for VAT) and BANK_CHARGES (UAE bank fees are typically exempt). A wrong figure on Form 201 is a real problem; a missing entry is a known one. Zero-default forces the operator to explicitly assert a non-zero — see the form's live subtotal caption + refuse-on-mismatch counter (same shape as the payment allocation counter, per AR 2026-09-02).

**Invariant: `total = subtotal + vatAmount`.** Enforced two places:
1. Client-side: the record-expense form's VAT input turns red and refuses to submit when `vatAmount > total` (see `ExpenseAmountFields.tsx`).
2. Server-side: `recordExpenseAction` refuses the same case with a clear message, so a scripted / bookmarked submit can't bypass the client check.

**Cutover invariant (rule 10 discipline).** Pre-E1f rows were back-filled as `subtotal = total, vatAmount = 0`. Back-calcing `total × 5/105` into a reclaim number the operator never asserted would fabricate data. The 1 row on Prod at cutover (Demo RENT AED 5,000, VOID) reads as gross-with-zero-VAT permanently; the operator can void + re-record if the landlord actually invoiced VAT and the reclaim matters.

**Category caveat, not a blocker.** The form shows the VAT input on every category (including SALARIES / BANK_CHARGES). Hiding the field on some categories reads as the system enforcing a tax rule it doesn't understand — some banks do charge VAT on FX / card processing / merchant services, and the operator has to be able to enter it. The default-zero + explicit-entry protocol carries the discipline, not the visibility of the field.

---

## 13. Profit &amp; Loss reads the ledger, and labour is not COGS

The P&amp;L computes from `LedgerEntry` rows alone — no aggregation over `Invoice`, `Expense`, or `Part.cost`. The whole point of full-accrual bookkeeping is that the ledger is the single source of truth; a report that ignores it is a report that will disagree with the auditor's export. `src/lib/pnl.ts` reads REVENUE-typed accounts (CR-normal, flipped for display), `COGS` (DR-normal), and every EXPENSE-typed account (DR-normal), summed via a helper that turns a bag of rows into a signed balance. Zero-balance accounts don't render as lines — the shop that only paid rent this month sees a rent line, not eleven expense rows padded with AED 0.

**Labour is not COGS.** A LABOR line on an invoice contributes to Sales Revenue via the standard `INVOICE` post (`DR AR / CR Sales`). It has no counterpart on the COGS side. Technician salary — the actual cost of delivering that labour — enters the ledger only when the shop records a salary payment via `recordExpenseAction`, landing as `DR EXP_SALARIES / CR Cash`. Booking labour revenue against a labour-COGS row would double-count the same wages: once as the invoice's COGS pair, once as the salary expense. Gross Profit therefore includes labour revenue in full; Net Profit subtracts salaries via the P&amp;L Salaries line. Rule 10 has the same statement in prose; this rule pins it as a P&amp;L invariant.

**Consequence for shops that don't record staff salaries.** A P&amp;L with revenue but zero Salaries line reads as a shop with no staff. It's not — it's a shop that hasn't recorded a salary payment yet. The page doesn't warn about this today; the ask is that operator training + rule 12 (expenses discipline) get salaries entered as they're paid. If the gap becomes noise, the next iteration adds a Salaries-coverage warning next to the coverage banner for COGS.

**Coverage banner.** Two conditions surface a warning next to the report:

1. `garage.cogsEnabled = false` **and** revenue &gt; 0 → the whole COGS line is zero because the per-garage flag is off. Explanation: cost tracking hasn't been switched on for this garage. Until then Gross Profit overstates.
2. `cogsEnabled = true` but not every invoice in the period has a COGS pair → "N of M invoices costed (X%)." Explanation: invoices raised before cost tracking was switched on stay uncosted; invoices whose PART lines had no supplier cost recorded also skipped their cost-of-sales entry (see the C4 rollout in rule 10 for the technical mechanism).

Full coverage (or zero revenue) → no banner. Same "surface the gap, don't fake it" discipline as rule 12 on VAT.

**Customer-facing text has no internal spec references.** Rule numbers, `cogsEnabled` flag names, `sourceType` values, "cutover" jargon — those live in code comments and this doc. The banner and every other operator surface uses plain wording: "cost tracking is off" not "cogsEnabled=false", "invoices raised before cost tracking was switched on" not "pre-cutover invoices stay uncosted (rule 10)". A shop owner reads the P&amp;L; they never opened this file. If the banner sends them here to understand what a warning means, the banner failed.

**Coverage percentage stays prominent as coverage improves.** At 2% ("1 of 48 invoices costed") the raw ratio is self-evidently absurd — the banner does easy work. At 70% ("42 of 60 invoices costed") the margin reads plausibly and Gross Profit LOOKS trustworthy at a glance; the banner is doing the load-bearing work of naming that 18 invoices are missing cost data. That's exactly when the percentage cannot shrink into a body sentence. The banner renders the "N of M (X%)" line in `text-base font-semibold` inside a warning-tinted border regardless of the ratio, and the explanatory body stays smaller. Don't reintroduce a "warn louder when the number is worse" gradient — the loudest signal has to be there when the number is *closest to plausible*, because that's when the operator most needs the reminder.

**Coverage banner prints alongside the P&amp;L.** The coverage line is inside `data-print-document="pnl"` with NO `print:hidden` class. A printed P&amp;L that leaves the office without the coverage caveat beside it is the document that gets believed at face value by whoever reads it next (accountant, bank, spouse). The nav / filter / preset buttons hide on print; the numbers and their caveats do not.

**Half-open interval.** Date filter uses `[from, to)` — a row at exactly `to` is excluded. Consequence: "September 2026" = `from = 2026-09-01, to = 2026-10-01`. A ledger post at `2026-10-01 00:00:00Z` lands in October, not September. Documented in the page's "To (exclusive)" label; test `src/lib/__tests__/pnl.test.ts` pins the boundary behaviour.

**Timezone note.** The MVP reads UTC boundaries from the operator's date-picker input. UAE is UTC+4, so a receipt logged at 23:30 local on Sept 30 lands at 19:30 UTC same day — close enough that month-boundary drift is rare and never large. A per-garage timezone flip is a future enhancement, not blocking rule-10 rollout. If a shop's P&amp;L for a single day disagrees with what they expect by one late-night receipt, this is the reason.

**Common violation shape:** "let's read Invoice.total in the P&amp;L instead of joining ledger, it's simpler." That's the divergence path — an invoice's total changes on edit and void, and the ledger has the history; the Invoice row has only the current state. The auditor sees the ledger. If the P&amp;L reads Invoice.total, they diverge, and the wrong one is the report. Same shape as computing Gross Profit from `Part.cost` live rather than the frozen `InvoiceLine.unitCost` — the snapshot exists so old invoices don't rewrite on today's price movements (see `src/lib/invoice-cost-snapshot.ts`).

## 14. VAT summary reads the ledger and doesn&apos;t file returns

The VAT summary (E4, AR 2026-09-02) computes from `LedgerEntry` rows only — output VAT from `VAT_PAYABLE` (CR-normal, flipped for display), input VAT from `VAT_INPUT` (DR-normal). No aggregation over `Invoice.vatAmount` / `Expense.vatAmount` / `SupplierBill.vatAmount`. Same rule 13 discipline as the P&amp;L — reading the source tables lets the report diverge from the ledger the auditor sees, and there is no version of that where the ledger is the wrong one.

**Net payable formula.** `netPayable = outputVat − inputVat`. Positive means the shop owes the FTA; negative means a refund is due. The number is presented that way on the page (labeled "Net VAT payable" or "Net VAT refund" depending on sign) — no unsigned absolute value that leaves the direction ambiguous.

**Void reversals net cleanly.** `INVOICE_VOID` posts `DR VAT_PAYABLE` reversing the original CR; `SUPPLIER_BILL_ADJUSTMENT` posts `CR VAT_INPUT` reversing the original DR; `EXPENSE` void reverses the VAT row when it exists (E1f). Reading VAT balances across ALL sourceTypes gives the correct net — the summary never double-counts a voided invoice or expense.

**Coverage banner — same shape as the P&amp;L coverage note.** Two conditions:
1. `expensesTotal &gt; 0` AND `expensesWithVat = 0` → **every** ACTIVE expense in the period reads zero VAT. Usually means nobody entered the split when recording them; the reclaim is under-reported. Banner names the number and directs to the Expenses page.
2. Partial coverage (some carry VAT, some don&apos;t) → legitimate for salaries, most bank charges, and any zero-VAT supplier; but flagged so the operator can review. Percentage renders `text-base font-semibold` per rule 13 &sect;"stay prominent as coverage improves".

Supplier bills also carry a coverage count, but informational only — Payables C3 enforces VAT capture at receive-form time, so a zero-VAT bill on that side is a deliberate operator choice, not an omission.

**Half-open interval.** `[from, to)`. A ledger post at `2026-10-01 00:00:00Z` lands in Q4, not Q3. Quarter presets (`Q1..Q4`) generate boundaries `[YYYY-Qm-01, YYYY-Q(m+3)-01)`.

**We produce figures, we don&apos;t file.** Every mention of the return on the page names the FTA portal as the filing surface. The page carries an always-visible "This is a working summary, not a return" note that prints alongside the numbers (same discipline as the P&amp;L coverage banner). The page never has a "Submit return" button, a "Mark filed" toggle, or anything else that could be misread as filing. Corrections, adjustments, and the actual submission live on `tax.gov.ae`; this page is what the accountant transcribes into the boxes there.

**Common violation shape:** "add a `Mark as filed` toggle on the VAT summary so the operator can track what they&apos;ve submitted." That toggle is a Form 201 tracking system, and it belongs on the FTA portal or the accountant&apos;s ledger — not here. Once we start tracking filing state we start being wrong about it (the FTA rejects a submission, the operator forgets to unmark), and the shop&apos;s record diverges from the government&apos;s. If a shop needs to track what they&apos;ve filed, that&apos;s a separate feature request that spec first.

### E4b — per-emirate seven-box breakdown (AR 2026-09-03)

Form 201 splits standard-rated supplies across the seven emirates (boxes 1a–1g). The VAT summary produces one row per emirate that had activity, in Form 201 order (Abu Dhabi → Dubai → Sharjah → Ajman → UAQ → RAK → Fujairah). Columns: Standard-rated supplies, Adjustments, Net.

**Emirate is snapshot on the invoice, not read from the garage live.** `Invoice.emirate` is captured by `generateInvoiceAction` inside the same tx that creates the invoice — same freeze-at-issue discipline as `InvoiceLine.unitCost`, `customerTrn`, `advisorNameSnapshot`. A garage that later moves office or adds a branch NEVER rewrites the emirate on invoices that were already issued: Form 201 for a prior quarter is final, and any per-emirate rewrite would put the shop out of sync with what they already declared to the FTA.

**`reissueInvoiceAction` reads Garage.emirate fresh**, not the voided invoice's snapshot. Reason: the whole point of reissue is that the void was wrong; if the void was wrong *because* the emirate was wrong, the reissue picks up the newly-corrected setting.

**Void reversal has no separate emirate.** `INVOICE_VOID` ledger rows join back to the ORIGINAL `Invoice` row via `sourceId` — the reversal always lands in the same emirate box as the original, regardless of what `Garage.emirate` is at void time. Pinned by test "Cross-quarter void inherits ORIGINAL emirate even if Garage.emirate changed" in `src/lib/__tests__/vat-summary.test.ts`.

**Standard vs Adjustments split** (Option A per AR 2026-09-03 — query change, no schema change):
- **Standard column** for an emirate = sum of VAT_PAYABLE contributions from `INVOICE` rows in the period + same-period `INVOICE_VOID` reversals (nets against the original sale). Every invoice raised inside the period reports here.
- **Adjustments column** for an emirate = sum of VAT_PAYABLE contributions from `INVOICE_VOID` rows in the period whose ORIGINAL invoice was raised OUTSIDE the period. Cross-quarter voids only.

Reason: the FTA convention for prior-period voids is the Adjustments column, not a subtraction from the current quarter's Standard row. The original invoice was already declared on its own quarter's Form 201 and can't be re-declared; the reversal shows up as an adjustment on the current return.

**Null-emirate invoices render as an "Unassigned" bucket.** Any invoice whose `Invoice.emirate` snapshot is null (pre-cutover invoices where the garage's emirate wasn't set, or invoices raised while `Garage.emirate = null`) lands in a highlighted `Unassigned` row on the VAT summary table with a "no Form 201 box" label. The coverage banner surfaces the count. Fix path: set `Garage.emirate` in Settings (so *future* invoices snapshot the right value), then an operator runs `scripts/backfill-invoice-emirate.mts` to inherit the setting onto pre-cutover null-emirate rows. Same "surface the gap, don't fake it" discipline as rule 12 and 13.

**Never void a sent invoice to fix a display-only field.** Voiding an invoice runs the full reversal machinery: burns an invoice number (gapless sequence), posts an `INVOICE_VOID` ledger pair (creating an Adjustments-column entry for future quarters), and if reissued produces a credit-note-shaped correction the customer didn't ask for. All of that is the correct discipline when the invoice itself was **wrong** (mispriced, misaddressed, sent to the wrong customer) — none of it is correct when the only problem is that a REPORT displays "Unassigned". A sent invoice's business record is what the customer received; a report is a query over the ledger. Fix the report, don't rewrite the record.

Concretely — for any Invoice column that only feeds reports, the correction path is a targeted UPDATE via an operator script (idempotent, dry-run first), NOT `voidInvoiceAction` + `reissueInvoiceAction`. `Invoice.emirate` is the first such column; the pattern will recur for any future snapshot column added for reporting purposes.

**Common violation shape:** "the report says Unassigned, let me void + reissue this month's invoices to fix it." This burns 30+ invoice numbers, posts 30+ reversal pairs into the current quarter (which show up as legitimate INVOICE_VOID entries — good luck telling those apart from real corrections at audit), 30+ reissued invoice numbers, and confuses every customer who paid the original. The correct action is one SQL UPDATE per garage.

**Input VAT stays entity-level.** No per-emirate split on the reclaim side. Form 201 treats input VAT at entity level (one number for the whole shop) — a purchase for the Dubai branch or the Sharjah branch reclaims into the same pool.

**Backfill discipline for pre-cutover invoices.** The E4b migration back-fills `Invoice.emirate` from `Garage.emirate` per row (null-safe: garages without emirate leave their invoices null too). Rule 14 discloses that pre-cutover invoices carry an INFERRED value from the garage's current setting — accurate if the shop never moved, best-effort if it did. The auditor reading the export knows the field wasn't captured at generation time; the per-invoice snapshot is authoritative for anything raised after cutover.

## 15. Purchase summary reads the ledger and doesn&apos;t merge stock with direct-fit

The purchase summary (E6, AR 2026-09-03) answers &quot;what did I buy and what did I pay&quot; — an operator surface, MASTER + OWNER open, distinct from the P&amp;L / VAT / Trial-Balance financial-reporting bucket. Same ledger-only discipline (rules 13 + 14) for money numbers: `totalPurchased` from `VAT_INPUT`+`INVENTORY`-side AP credits (`sourceType='SUPPLIER_BILL'` netted with `SUPPLIER_BILL_ADJUSTMENT`), `totalPaid` from AP debits (`sourceType='SUPPLIER_PAYMENT_ALLOCATION'`). Nothing reads `SupplierBill.total` or `SupplierPayment.amount` for the totals; those tables answer &quot;what is the current state&quot; not &quot;what happened in this period.&quot;

**Stock and direct-fit are separate flows and stay separate in the report.** Direct-fit lines don&apos;t post to AP (rule 10) — the parts never enter Inventory, the shop pays the supplier out of hand or the operator uses the `billSubtotal` override to reconcile a mixed bill. Consequences for this report:
- `totalPurchased` (from AP) EXCLUDES direct-fit spend.
- The by-part breakdown reads from `PartMovement` (stock only) — direct-fit parts land on `JobPartReceipt`, which the by-part query does NOT union in.
- A coverage banner surfaces direct-fit spend explicitly, so an owner comparing &quot;total purchased&quot; to &quot;by-part total&quot; sees the gap named rather than guesses at it.

**Never merge the two into a single &quot;total spent&quot; number.** Merging looks convenient but breaks the AP invariant every downstream number (Payables aging, supplier statements, cash-flow forecasting) relies on. The right answer to &quot;what did I spend&quot; over a period is two numbers: purchases-on-account + direct-fit-out-of-hand. The report presents them separately and names the split. Same &quot;surface the gap, don&apos;t fake it&quot; discipline as rule 13.

**By-part spend reads the frozen snapshot on `PartMovement.unitCost`, not the live `Part.cost`.** Live `Part.cost` is a rolling weighted average — reading it at report time attributes today&apos;s cost to a receive that happened last quarter, producing a number that changes every time a new receive shifts the average. The snapshot (added E6, populated at receive-write time by `receivePurchaseOrderAction`) freezes what was actually paid on that specific receive. Historical pre-E6 rows carry null `unitCost`; the by-part row still shows the qty but the spend renders as &quot;—&quot; and the coverage banner names the uncosted-movement count. Same discipline as `InvoiceLine.unitCost` (rule 10) and `Invoice.emirate` (rule 14): frozen at write, never live-recomputed, cutover rows disclosed.

**Never parse `PartMovement.reason` for structural information.** The `reason` field is free-text human context (&quot;Received PO REF-123 — Al Falah Motors&quot;) written for operator readability. It is NOT a structural link. Anything the report needs to know about a movement — which PO it came from, which supplier, what the cost was — must come from typed columns (`purchaseOrderId`, `partId`, `unitCost`, joined-through `Part`/`PurchaseOrder`/`Supplier`). A report that parses `reason` breaks silently the first time a writer changes the string, and the drift is invisible until an accountant asks why the numbers stopped matching.

**Outstanding is a snapshot, not a period aggregate.** &quot;What do I still owe this supplier&quot; asks about current state, not about a date range. The by-supplier &quot;Outstanding&quot; column sums `SupplierBill.total − paidAmount` across all non-VOID bills for that supplier, regardless of `billDate`. Consequence: two runs of the report over different periods can show the same &quot;Outstanding&quot; number for a supplier — that&apos;s correct behaviour, not a bug. The banner clarifies this in one line.

**Common violation shape:** &quot;the operator wants one big Purchases number, merge stock + direct-fit.&quot; Every subsequent report that reconciles against AP (Payables, statements, the P&amp;L&apos;s Cost of Goods Sold line) then diverges from the merged number, and the shop&apos;s books stop tying out. If the operator&apos;s question is &quot;how much cash left the shop for parts,&quot; that&apos;s a different report — combine the AP-payment number with direct-fit-cash and label it as a cash-flow view, not a purchase view.

## Historical audit gaps

Where a fix adds a new audit column to a table, prior rows can't
be back-populated — the actor/timestamp for the pre-migration
event is simply gone. Named here so nobody spends time investigating
one.

**JobCard cancellations before 2026-08-29** — `JobCard.cancelledAt`,
`cancelledByUserId`, and `cancelReason` were added in migration
`20260829000000_jobcard_cancelled_audit`. Cancellations recorded
before that migration ran on Prod have all three fields NULL, and
the timeline surface renders no `tlJobCancelled` entry for them.
There is no way to tell who cancelled the job, when specifically,
or why — only that the status flip happened on or before the row's
`updatedAt`. If an auditor asks about a cancelled job whose
`updatedAt` predates 2026-08-29, the answer is "unattributable —
see business-rules.md."

**JobCard holds before 2026-08-29** — `JobCard.heldAt` and
`heldByUserId` were added in migration
`20260829010000_jobcard_held_audit` (sibling to the cancellation
migration). `holdReason` + `holdNote` already existed and carried
context, but not "when" or "who." Holds recorded before the
migration have both new fields NULL and produce no `tlJobHeld`
timeline entry. Same rule as cancellations: `updatedAt` is the
only signal, unattributable in practice.

Also: on both cancellation and hold, if a job cycled through
multiple transitions (held → resumed → held again), only the
LATEST occurrence is preserved — same limitation the existing
`holdReason` field carries today. A per-transition history model
(JobHoldEvent, JobCancellationHistory) would fix this if the
audit ever needs it; not built today.

## How to use this doc

Before shipping a change that touches money, parts, POs, or customer
messaging: read the rule that applies + check the change against the
"common violation shape" section. If the change matches, the shape is
wrong — even if the tests pass, even if the requirement seemed to
call for it.

When a design decision gets corrected on business grounds, land the
correction here in a numbered section. Rules don't move once
numbered — appending is fine, renumbering breaks cross-refs in code
comments and commit messages.
