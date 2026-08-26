# ERPNext pilot brief — first-shop rollout

Stub. Fleshed out closer to the first shop's ERPNext cutover. Two things
are locked in from the design-decision round and belong prominently at
the top of any live version:

## Q: Why is there only one Item for parts?

**Every parts line on every invoice references the same ERPNext Item
called `GARAGEOS-PART`.** Same shape for labour (`GARAGEOS-LABOR`),
sublet (`GARAGEOS-SUBLET`) and fees (`GARAGEOS-FEE`) — four Items
total, one per line kind.

This is deliberate. The GarageOS side of the equation is 87 % free-text
line descriptions (78 unique descriptions across 89 recorded lines at
audit-time — 11 catalogued parts, 78 one-offs). If we auto-created
an ERPNext Item per description, the Item table would grow with every
new descriptive variant a cashier types. "Brake pad" vs "brake pads"
vs "Brake Pad Set" would become three different Items, reports would
fragment, and no one ever merges them.

Instead, the line's real name — what the customer sees on the printed
invoice — lives in the ERPNext Sales Invoice line's **Description**
field, overriding the Item name. The GL posting is identical either
way. The Item is a bucket for kind-level reporting on ERPNext side;
the description is where the specific-item information lives.

If a shop later wants per-catalogue-part analytics on ERPNext directly
(the 11 real catalogue parts), we upgrade to a hybrid: catalogued
lines get their own ERPNext Item, free-text lines stay generic. That
upgrade is documented as a half-day change in the integration scope;
we don't build it until a shop asks.

## Q: Why do ERPNext invoice numbers not match INV-YYYY-####?

GarageOS uses a gapless per-garage numbering sequence for the invoices
that reach customers (VAT-audit requirement). ERPNext generates its own
document names via its `naming_series`. We store both — GarageOS keeps
the customer-facing INV number, ERPNext keeps its own name for its
own reports. GarageOS is the authoritative record of what was billed;
ERPNext is the accounting projection.

If the shop's accountant reads reports in ERPNext, they'll see ERPNext
names in the Sales Invoice list. To match a specific invoice to the
customer-facing document, they use the custom field carrying the
GarageOS INV number, which is set on every synced invoice.

## Instance setup — Cash/Bank - GOS

Create one account **Cash/Bank - GOS** under the Company, Account
Type = **Bank**, root type Asset. Then repoint both Company defaults
at it:

- Company → **Default Cash Account** → `Cash/Bank - GOS`
- Company → **Default Bank Account** → `Cash/Bank - GOS`

Rationale: GarageOS records payments as one bucket (`Cash/Bank`).
ERPNext's out-of-the-box Company defaults point at separate `Cash -
<abbr>` and `<Bank> - <abbr>` accounts; leaving them split means a
Payment Entry synced from GarageOS lands on whichever account
ERPNext picks by heuristic (usually mode-of-payment) and the two
sides of the recon report diverge. Collapsing both defaults onto
`Cash/Bank - GOS` matches the GarageOS ledger 1:1.

The five-account map from the design round:

| GarageOS ledger    | ERPNext account          | Account Type     |
| ------------------ | ------------------------ | ---------------- |
| AR                 | `Debtors - <abbr>`       | Receivable       |
| Cash/Bank          | `Cash/Bank - GOS`        | Bank             |
| Customer Deposits  | `Customer Deposits - GOS`| Payable          |
| Sales Revenue      | `Sales - <abbr>`         | Income Account   |
| VAT Payable        | `VAT 5% - <abbr>`        | Tax              |

## Invoice creation — read-back assertion

Every Sales Invoice we POST is fetched back (GET
`/api/resource/Sales Invoice/{name}`) before we mark our own row
`SYNCED`. The read-back asserts the doc came out of ERPNext with
the fields we sent, not with silent server-side coercions.

Assert on the returned doc:

- `docstatus == 1` (submitted, not draft)
- `customer` matches our `Customer.erpnextCustomerId`
- `posting_date` matches our `Invoice.createdAt` date
- `grand_total` matches our `Invoice.grandTotal` to the cent
- `outstanding_amount == grand_total - (sum of allocated advances)`
- `taxes[]` contains one row with `account_head =
  "VAT 5% - <abbr>"` and `tax_amount == Invoice.vatAmount`
- **`allocate_advances_automatically == 1`** — Company flag echoed
  onto the invoice. Without it, a Payment Entry raised earlier as
  a customer deposit sits as an unallocated advance forever;
  outstanding stays at grand_total; the shop's receivables report
  is wrong and no error surfaces. Silently ignored deposit is
  exactly the invisible failure the assertions exist for; belongs
  in the same contract as the advance checks.
- If any advance was applied: `advances[]` non-empty, each entry's
  `reference_type == "Payment Entry"`, and `sum(advances[].allocated_amount) ==
  grand_total - outstanding_amount`.

An assertion failure means we DON'T mark `SYNCED`; the invoice
row stays `PENDING` and the sync-status chip on `/invoices/[id]`
goes red with the failing field named. The shop can raise the
dispute against a concrete field, not "ERPNext acted weird."

## Other prominent notes to add before shop cutover

- Kill-switch (`Garage.erpSyncEnabled`) — how the shop pauses sync
  during a dispute or offboarding.
- Sync status chips on `/cashier` and `/invoices/[id]` — what green /
  amber / red mean.
- Nightly reconciliation report — what lands in the owner's inbox and
  what to do about a divergence line.
