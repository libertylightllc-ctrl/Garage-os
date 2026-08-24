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

---

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
