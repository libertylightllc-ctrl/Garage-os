# ERPNext sync — implementation brief

Full analysis, gate evidence and posting-shape diagrams:
https://claude.ai/code/artifact/1899e53e-943f-4608-a19a-f590704e975c

This file is the operative summary. Where it and the artifact disagree, the artifact is older —
this file wins. Everything below was verified against a live ERPNext instance
(frappe 16.31.0 / erpnext 16.32.3, company `garageos`, abbr `GOS`, AED) on 26 August 2026.

---

## 0. What this is

One-way push of GarageOS ledger events into ERPNext. GarageOS remains the system of record.
ERPNext receives copies for the accountant. Nothing flows back.

## 1. Non-negotiable constraints

1. **Never in the request path.** Nothing in GarageOS may depend on ERPNext being reachable.
   If ERPNext is down, slow or misconfigured, advisors still create estimates and cashiers
   still issue invoices and record payments. The sync is a queued side-effect.
2. **Never fail a user action on a sync failure.** Queue it, retry it, surface status.
   The invoice is issued regardless.
3. **Additive only.** New tables and new columns. Do not modify existing actions, existing
   ledger writers, or existing queries. If a change to working code appears necessary,
   **stop and report** rather than making it.
4. **GarageOS ledger is source of truth.** ERPNext receives copies.
5. **Behind a per-garage flag, off by default.**

## 2. Account map

| GarageOS | ERPNext |
|---|---|
| Accounts Receivable | `Trade Receivable - GOS` |
| Cash/Bank (collapsed, one account) | `Cash/Bank - GOS` |
| Customer Deposits | `Customer Deposits - GOS` |
| Sales Revenue | `Sales Account - GOS` |
| VAT Payable | `VAT 5% - GOS` |

Bank reconciliation is deliberately NOT done in ERPNext. Payment method stays on the
GarageOS payment row; ERPNext's per-instrument account split goes unused.

## 3. Config prerequisites — these break deposits SILENTLY

Neither is visible in the chart of accounts. Both were found the hard way.

- **`Customer Deposits - GOS` must have Account Type `Receivable`** (on a Liability-root
  account — ERPNext accepts this). Without it, no `Payment Ledger Entry` row is written and
  the deposit can never be applied to anything, ever. Nothing errors.
- **Every pushed Sales Invoice must set `allocate_advances_automatically = 1`.** The manual
  `set_advances` / "Get Advances Received" path returns empty on erpnext 16; the auto path works.
  This is a per-document field defaulting to 0 — there is no company-level equivalent. See §5b.
- **Company:** `book_advance_payments_in_separate_party_account = 1` with
  `default_advance_received_account = Customer Deposits - GOS`.
- **Company defaults:** receivable `Trade Receivable - GOS`, income `Sales Account - GOS`,
  bank and cash **both** `Cash/Bank - GOS`.
- **Company:** `disable_rounded_total = 1` (added 27 August 2026 after
  ACC-SINV-2026-00012 showed `grand_total 999.99` posting to receivables as
  `rounded_total 1000.00`, leaving a 0.01 residue after payment). The per-invoice
  `disable_rounded_total = 1` we send is defense-in-depth; the Company-level flag covers
  any invoice created outside the sync too.
- **System Settings:** timezone = Asia/Dubai. Otherwise a payment recorded on the 27th UAE
  time gets stamped as the 28th on ERPNext, and every ledger period boundary is off by a day.
- **Naming:** every Customer POST must send `naming_series: "CUST-.YYYY.-"` explicitly.
  Selling Settings `cust_master_name = "Naming Series"` tells ERPNext to name BY series;
  the series name itself still comes from each doc.
- **Payment Entry when `paid_to` is a Bank-typed account:** `reference_no` and
  `reference_date` are both mandatory. Cash/Bank - GOS is typed Bank, so every Payment
  Entry (both invoice payments and naked advances) must carry them. We send our
  GarageOS payment id + posting date; if a shop later starts capturing cheque numbers
  or txn ids, that becomes a Payment-row field to preserve.

### Verified state of the trial instance, 26 August 2026

All config below is applied and confirmed on company `garageos`. A fresh ERPNext deployment
needs every line of it reapplied.

```
default_receivable_account                       Trade Receivable - GOS
default_income_account                           Sales Account - GOS
default_bank_account                             Cash/Bank - GOS
default_cash_account                             Cash/Bank - GOS
book_advance_payments_in_separate_party_account  1
default_advance_received_account                 Customer Deposits - GOS

Cash/Bank - GOS          type Bank        Asset      ledger, under Cash in Hand & Banks - GOS
Customer Deposits - GOS  type Receivable  Liability  ledger, under Unearned Income - GOS

Customer.garageos_customer_id   Data, unique, indexed
Item.garageos_item_id           Data, unique, indexed
Selling Settings.cust_master_name = Naming Series
Stock Settings.item_naming_by     = Item Code        (deliberate — see §6)

Items: PART, LABOR, SUBLET, FEE — non-stock, income Sales Account - GOS
```

`unique` on the two ID fields is load-bearing: a duplicate push fails at the database rather
than silently creating a second record. It backstops the idempotency contract in §7.

> **Version caveat.** The manual and automatic advance paths disagreeing on erpnext 16.32.3 is
> plausibly a defect. Pin the version, or re-run the deposit gate after any upgrade.

## 4. Document shapes

All verified. Voucher numbers are real and still on the instance.

### Invoice issued
```
DR  Trade Receivable - GOS   (+party)   gross
CR  Sales Account - GOS                 net
CR  VAT 5% - GOS                        tax
```
- `items[]` each carry `income_account = "Sales Account - GOS"`
- **VAT: one `taxes[]` row, `charge_type = "Actual"`, `tax_amount` = the figure GarageOS
  computed.** Do not let ERPNext derive it — Actual preserves our per-line rounding exactly.
- `disable_rounded_total = 1`. Otherwise ERPNext books the rounding difference to a Round Off
  account we do not have.
- `allocate_advances_automatically = 1` — per-document, defaults to 0, assert on read-back (§5b).
- ERPNext groups GL credits by income account, so multiple lines against one Sales Account
  produce a single net credit row. That is already our shape — nothing is lost.

### Payment recorded
```
DR  Cash/Bank - GOS                     amount     (paid_to)
CR  Trade Receivable - GOS   (+party)   amount     (paid_from)
```
- `references[]` row `{reference_doctype: "Sales Invoice", reference_name, allocated_amount}`.
  Without it the payment posts but the invoice stays open.

### Advance taken (deposit)
```
DR  Cash/Bank - GOS                     amount
CR  Customer Deposits - GOS  (+party)   amount
```
- Ordinary Payment Entry, `payment_type = "Receive"`, no reference rows.
- Set `paid_from` to the receivable account; ERPNext rewrites it to Customer Deposits itself.
- Party lands on the deposits row only, not the cash row. That is correct and matches our model.
- Verified: `ACC-PAY-2026-00009`.

### Deposit applied
```
DR  Customer Deposits - GOS  (+party)   amount
CR  Trade Receivable - GOS   (+party)   amount
```
- **No separate document.** `allocate_advances_automatically = 1` on the invoice makes ERPNext
  find and apply the advance on save, posting against the original payment voucher.
- Verified: `ACC-SINV-2026-00011` pulled `ACC-PAY-2026-00009`. Outstanding 1000 → 500,
  payment `unallocated_amount` → 0, `total_allocated_amount` → 500.
- *Fallback only if a version change breaks this:* a Journal Entry with party plus
  `reference_type`/`reference_name` also works (`ACC-JV-2026-00001`), but leaves the payment's
  allocation fields stale — a phantom balance someone can double-apply. Avoid unless forced.

### Void
- Sales Invoice with `is_return = 1` and `return_against` pointing at the original.
- **Never the Cancel action.** Cancel reverses the GL but produces no tax document; UAE VAT
  requires a credit note. Void mapped to Cancel gives a balanced ledger and an indefensible
  VAT position.

## 5. Post-write assertions

The governing rule: **a 200 response is not success.** Read the document back and assert what
actually happened. Fail the job loudly on any mismatch — a failed job is visible, a silently
misbooked deposit is not.

**`is_advance` does not exist** on Payment Entry or Payment Entry Reference in erpnext 16.
Frappe silently discards unknown fields on write, so setting it produces a payload that looks
explicit and asserts nothing. Do not write it.

### 5a. Advance Payment Entry

1. `paid_from == "Customer Deposits - GOS"` — routing happened
2. `book_advance_payments_in_separate_party_account == 1` — setting was in force at write time
3. **A `Payment Ledger Entry` row exists for the voucher against `Customer Deposits - GOS`**

Check 3 is the decisive one. Its absence is the exact failure described in §3, it is invisible
in the Payment Entry itself, and checks 1 and 2 can both pass while the deposit is permanently
unallocable.

### 5b. Sales Invoice

`allocate_advances_automatically` is a **per-document field defaulting to 0**, not configuration.
It cannot be set once and forgotten. Miss it on a single invoice and that invoice silently
ignores an available deposit: outstanding stays at gross, the deposit stays in the liability
account, nothing errors, and the customer is chased for money they already paid.

1. `allocate_advances_automatically == 1` — the flag persisted
2. **Outcome check, whenever GarageOS knows an unapplied deposit exists for that customer:**
   assert `outstanding_amount == grand_total - expected_allocation`. If a deposit was expected
   and outstanding came back at full gross, the allocation did not happen — fail the job.

Check 2 matters more than check 1, for the same reason check 3 above matters more than checks 1
and 2: the flag can persist while the allocation still fails to occur. Assert the outcome, not
the input. That distinction is what the two-hour investigation in §3 turned on.

## 6. Identity — never match on name

ERPNext names Customer records by name OR by naming series. **Use naming series.** Store the
GarageOS ID in a custom field and make that the only match key.

- Customer: `customer_naming_by = "Naming Series"`, custom field `garageos_customer_id`, indexed
- Item: custom field `garageos_item_id`

A name difference then stops being a conflict and becomes a field to overwrite — GarageOS wins
on name, one-directionally. This matters because every UAE failure mode is name-shaped: Arabic
vs English renderings, trade-licence names vs counter names, fleet accounts where payer ≠ driver,
walk-ins keyed on phone or plate.

**Items: four generic Items, one per line `kind`,** with the free text carried as a line-level
description override. Real catalogue codes are used only where a part genuinely has one.
Do NOT create an Item per distinct billed description — there are 78 descriptions against
11 catalogue parts, and most billed lines are ad-hoc text.

The four exist on the instance. **`item_code` is the `kind` value verbatim, so the mapping is
identity — no lookup table.**

| `kind` | `item_code` | Item Group | UOM |
|---|---|---|---|
| PART | `PART` | Products | Nos |
| LABOR | `LABOR` | Services | Hour |
| SUBLET | `SUBLET` | Services | Nos |
| FEE | `FEE` | Services | Nos |

All four: `is_stock_item = 0`, `is_sales_item = 1`, income account `Sales Account - GOS` via
`item_defaults`. Non-stock is deliberate — these must never touch inventory valuation.

**DISCOUNT is not a fifth item.** A discount is a `FEE` line at negative price. Do not create a
DISCOUNT item and do not route discounts through ERPNext's own discount fields; a negative-price
FEE line keeps the ledger shape identical to ours and keeps the net credit on
`Sales Account - GOS` where it belongs.

Item naming stays `Item Code` (**not** Naming Series, unlike Customer). That asymmetry is
deliberate: real part numbers should *be* the `item_code`, so ERPNext must not overwrite them
with a generated series.

## 7. Architecture

### Change feed — tail, do not add an outbox
An outbox is technically better (transactional, ordered, no lag) but requires emitting an event
from an existing ledger writer, which violates constraint 3. **Tail the existing tables from a
cursor instead** — additive by construction, the write path never learns the sync exists, and
constraints 1–3 hold structurally rather than by promise.

If an emitted event or outbox already exists in the codebase, use it — that is not a modification.

### Idempotency — the one that corrupts ledgers
Before creating anything in ERPNext, consult the entity map. After creating, **write the map row
in the same transaction as marking the job complete.**

A push that succeeds in ERPNext but fails to record its map row will duplicate the invoice on
retry. ERPNext assigns names by naming series, so the map is the *only* link between the two
systems — there is no natural key to recover from.

### Ordering
An invoice cannot post until its customer and every one of its items already exist in ERPNext.
Jobs need dependency ordering (`depends_on`), not just retry. A part fitted and invoiced in the
same minute means an Item must be created and confirmed before the invoice can go.

## 8. Phases

| # | Phase | Depends on |
|---|---|---|
| 0 | ERPNext config (§3), custom ID fields, Customer naming, four generic Items — **all applied on the trial instance; nothing outstanding** | — |
| 1 | State tables: entity map, job queue (with `depends_on`), cursor | — |
| 2 | Change feed — tail the ledger | 1 |
| 3 | ERPNext client: auth, timeouts, backoff, idempotency contract | 1 |
| 4 | Master sync: customers, items | 0, 1, 3 |
| 5 | Documents: invoice, payment, advance, deposit application, void — plus the §5 assertion | 4 |
| 6 | Per-garage flag (off by default), status surface, dead-letter + replay, monthly tie-out | all |

Monthly tie-out is five accounts, five numbers — a comparison rather than a reconciliation,
because the shapes are identical. That is the payoff for the shape discipline above.

## 9. Scope reality

17 customers, 11 catalogue parts, 78 distinct billed descriptions, 45 invoices, 9 June –
25 August 2026, AED 43,681.05 net — **almost all of it test data.** One real tenant ran two jobs
in July and stopped. The fixed engineering is ~9–13 days largely independent of record count.
This was built as a judgement call with that arithmetic in view, not in ignorance of it.

## 10. Follow-up — after the sync is running

**Restrict write access on Customer and Item to the integration user.** Deliberately deferred:
it is a hardening step, it needs an integration user that does not yet exist, and restricting
those doctypes also restricts humans in the ERPNext UI unless the role setup is right.

Not urgent while the sync is off, but it should not be skipped. Without it, anyone editing a
Customer or Item inside ERPNext creates drift that nothing detects and the sync will not
correct — GarageOS is source of truth, so it never reads back to notice.

## 11. Open item

**Phase 2 needs a decision against real code:** whether an emitted event already exists, or
whether tailing is the only additive option. Resolve this first.

## 12. Test data on the instance

`ACC-PAY-2026-00006/7/8/9`, `ACC-SINV-2026-00006`–`00011`, `ACC-JV-2026-00001/2`,
four test customers. Clean end-to-end native case: `ACC-PAY-2026-00009` → `ACC-SINV-2026-00011`.
