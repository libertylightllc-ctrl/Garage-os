# Accounting export — chart of accounts + mapping rules

Companion doc for `/owner/accounting` (page at [src/app/owner/accounting/page.tsx](src/app/owner/accounting/page.tsx), endpoint at [src/app/api/accounting/export/route.ts](src/app/api/accounting/export/route.ts), builders + code table at [src/lib/accounting-export.ts](src/lib/accounting-export.ts)).

The CSVs are shipped in a shape most accounting systems (QuickBooks, Xero, Zoho Books, Odoo, Wave, Tally) import with minimal remapping. This doc is the reference an accountant reads once during setup, then again when reconciling anything odd.

**Audience:** the accountant configuring the target system, and the future engineer wiring a live integration.

---

## 1. Chart of accounts

Exported as `chart-of-accounts.csv` (COA setup — import first, once per target system).

| Code | Name | Type | Normal balance | Currency | Notes |
|---|---|---|---|---|---|
| 1000 | Cash on Hand | Asset | DR | AED | Derived at export from `Payment.method = "CASH"` |
| 1010 | Bank / Card POS | Asset | DR | AED | Derived at export from `Payment.method = "CARD"` |
| 1100 | Accounts Receivable | Asset | DR | AED | |
| 2100 | VAT Payable | Liability | CR | AED | UAE 5% output VAT |
| 2200 | Customer Deposits | Liability | CR | AED | Advances received before an invoice exists |
| 4000 | Sales Revenue | Revenue | CR | AED | Subtotal (VAT-exclusive) |

Codes are a conventional UAE-SME numbering. If the target system already uses different codes, remap once on import — the names are the stable identifier and match what appears on the on-screen [/owner/ledger](/owner/ledger) view.

**No expense accounts, no COGS, no payables, no payroll.** The ledger is revenue-side only. See §5.

---

## 2. Cash/Bank split — mapping-only

**Deliberate design.** The database stores a single ledger account called `Cash/Bank` (see [src/lib/billing.ts](src/lib/billing.ts) `ACCOUNTS.CASH`). Every payment — cash or card-POS — writes to the same string. The CSV export splits this into two account codes (1000 and 1010) at wire time by joining to the resolved `Payment.method` on the ledger row's `sourceId`.

**Why mapping-only, not a schema split:**
- The ledger reconciliation was completed and drilled recently. Adding a column to `LedgerEntry` to distinguish cash vs. card is a schema change on a system in known-good state.
- The `sourceId` on every `Cash/Bank` row already resolves to a `Payment` (or `AdvancePayment`) that carries the method — the information isn't missing, it's just not denormalised.
- If the target accounting system needs a different split (e.g., per bank account, per POS terminal), the same mapping approach extends without a schema change.

**Limitations of the mapping approach:**
- An orphan `Cash/Bank` ledger row whose `sourceId` doesn't resolve (a `Payment` row deleted after the fact, though the delete-guard trigger blocks this — see [prisma/migrations/20260819160000_ledger_source_delete_guard](prisma/migrations/20260819160000_ledger_source_delete_guard)) is defaulted to code 1000 (Cash on Hand). This is a conservative fallback: a mystery cash row that reconciles under Cash on Hand looks like a cash-drawer reconciliation item, whereas defaulting to Bank / Card POS would silently pollute bank reconciliations. See `resolveCashAccount()` in [src/lib/accounting-export.ts](src/lib/accounting-export.ts).
- `Payment.method` today is `CASH | CARD` only. Any future method (bank transfer, cheque, Apple Pay) needs a new code assignment before export — the current mapping falls through to Cash on Hand.
- A live accounting integration (as opposed to CSV handoff) should probably promote this to a stored column, so writes are authoritative. For CSV handoff to an external accountant, mapping-only is enough.

---

## 3. Which ledger events post which lines

The five `sourceType` values ever written to `LedgerEntry` (defined in [src/app/actions/billing.ts](src/app/actions/billing.ts), shape functions in [src/lib/billing.ts](src/lib/billing.ts)) map to journal shapes as follows:

### INVOICE — issuing an invoice (`generateInvoiceForJobAction`)

| Account | Code | DR | CR |
|---|---|---|---|
| Accounts Receivable | 1100 | total | |
| Sales Revenue | 4000 | | subtotal |
| VAT Payable | 2100 | | vatAmount |

### INVOICE_VOID — voiding a delivered invoice (`voidInvoiceAction`)

Exact mirror of INVOICE — flips DR/CR on every line so the sum across the two events nets to zero on every account.

### PAYMENT — recording a payment against an invoice (`recordPaymentAction`)

| Account | Code | DR | CR |
|---|---|---|---|
| Cash/Bank → 1000 or 1010 (see §2) | | amount | |
| Accounts Receivable | 1100 | | amount |

### ADVANCE — advance received before invoice (`recordAdvancePaymentAction`)

| Account | Code | DR | CR |
|---|---|---|---|
| Cash/Bank → 1000 or 1010 | | amount | |
| Customer Deposits | 2200 | | amount |

### ADVANCE_MIGRATION — advance reclassified onto invoice (written inside `generateInvoiceForJobAction`)

| Account | Code | DR | CR |
|---|---|---|---|
| Customer Deposits | 2200 | amount | |
| Accounts Receivable | 1100 | | amount |

Cash is untouched here (already recognised at ADVANCE time). Net effect across ADVANCE + ADVANCE_MIGRATION + INVOICE for a fully-advanced invoice is: cash DR (once), deposits net zero, sales + VAT CR (once), AR net zero.

---

## 4. The exported files

Downloaded from `/owner/accounting` (OWNER-only). Filenames include the date range (`accounting-<file>-<from>_<to>.csv`) so a file remains self-describing after a download tab closes.

| File | One row per | Notes |
|---|---|---|
| `chart-of-accounts.csv` | account | Time-invariant. Import first. |
| `journal.csv` | LedgerEntry in range | Ordered by createdAt ASC, id ASC. Full double-entry — sum of debit == sum of credit across every well-formed period. |
| `invoices.csv` | Invoice issued in range | Ordered by invoice number ASC. Includes paid + balance (computed from joined Payment rows). |
| `payments.csv` | Payment + AdvancePayment in range | `kind` column distinguishes. AdvancePayment carries the invoice it was later migrated onto in `migrated_to_invoice` (empty while still open). |
| `customers.csv` | Customer with ≥1 invoice in range | **Not the full customer list.** Range-scoped so PII leaving the app is limited to what the accountant needs to reconcile the accompanying invoices. |

Every download writes one row to `AccountingExportLog` (schema in [prisma/schema.prisma](prisma/schema.prisma)): who, when, what range, which file. Read via SQL editor for audit; no in-app viewer today.

---

## 5. What the export does NOT contain — read this before importing

The ledger is revenue-side only. What's missing that a target accounting system will notice:

- **No COGS / Inventory movement.** Parts sold at cost don't produce a Cost of Goods Sold entry. Gross margin from the exported journal is subtotal, not gross profit.
- **No expense accounts.** Supplier POs, wages, rent, subscriptions — none are ledgered. The books are one-sided.
- **No payables.** A purchase order that arrives with a supplier invoice does not create an Accounts Payable balance.
- **No payroll.** Technician hours and wages don't hit the ledger.
- **No fixed-asset or depreciation entries.**
- **No bank feed / reconciliation.** The Cash/Bank split above is inferred from `Payment.method`, not from an actual bank statement match.

**Consequence:** an accountant importing our journal into (say) Zoho Books will see a shop that only sells and never buys. Reconciliation against the shop's actual bank statement + supplier invoices happens outside GarageOS today, in whatever the shop was using before.

Two coherent framings for the accountant relationship:

1. **Sales-side sync only** — GarageOS is the authoritative source for revenue, AR, and VAT collected. Everything else lives in the accounting system and the accountant enters it there. Our export covers exactly what we own.
2. **Full books in GarageOS** — would require expense-side data model work: an Expense category, `LedgerEntry` writes for supplier PO receipts (COGS + Inventory movement), payroll accrual on tech hours, etc. Weeks of work, out of scope for this export.

Frame 1 is the current shape. If the shop is moving toward Frame 2, that's a separate spec conversation.

---

## 6. Audit trail

Every download of any file writes one row to the `AccountingExportLog` table:

```sql
SELECT "createdAt", "userId", "userRole", "ownerGarageId",
       "scopeGarageIds", "rangeFromIso", "rangeToIso", "file"
FROM "AccountingExportLog"
ORDER BY "createdAt" DESC
LIMIT 20;
```

The table has no foreign key into `User` or `Garage` — a user rename, role change, or (in theory) delete leaves the audit intact. `userId` and `userRole` are captured as flat strings so the audit reads as the state at the moment of export, not the current state.
