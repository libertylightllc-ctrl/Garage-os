# GarageOS — Roles, Dashboards & Job Card Spec

Four roles, one database per garage branch, four different interfaces. Captures the real garage process as described by the operator.

---

## Company / Branch structure

```
Company (e.g. Al Noor Auto Services) — Owner login
 ├── Branch: Dubai      — own staff, own WhatsApp number, own job queue
 ├── Branch: Sharjah    — own staff, own WhatsApp number, own job queue
 └── Branch: Abu Dhabi  — own staff, own WhatsApp number, own job queue
```

- **Owner** sees all branches aggregated; **branch staff** see only their branch.
- **Billing is per branch** (each branch = one subscription seat).
- Each branch connects its **own WhatsApp number** (self-serve embedded signup).

---

## The four roles

### 1. Company Owner
- Sees ALL branches at once: revenue, cars in progress, technician performance, VAT collected.
- Manages billing/subscription, adds/removes branches.
- High-level reports only — not day-to-day job operations.

### 2. Service Advisor (per branch)
- Creates the job card (see job-card section below).
- Assigns jobs to technicians (or releases to the shared pool).
- Sends estimates to the customer for approval (propose/confirm via WhatsApp).
- Manages the queue: waiting / in-progress / paused / completed.
- Does NOT set final prices — that's the cashier.

### 3. Technician (per branch)
- Sees ONLY jobs assigned to them + the shared waiting pool.
- Big-button workshop mode: claim a job, view customer complaint + mileage, add photos, add voice notes, request parts, mark complete.
- Claiming is atomic — one tech claims a car, it disappears from others' lists.
- Does NOT see pricing, billing, or other techs' jobs.

### 4. Cashier / Accounts (per branch)
- Receives job cards once the technician marks the work complete.
- **Decides/sets the price** and has FULL power to edit the invoice: add items, remove items, adjust prices, add notes.
- System **auto-adds VAT** (see VAT section) — cashier does not type it.
- Sends the final invoice to the customer (WhatsApp).
- Records payment (cash / card-POS — recorded, not processed).
- Marks job paid → ready for collection.

---

## Job Card creation (Service Advisor)

### New customer — Moulkia OCR
Advisor photographs the **Moulkia** (UAE vehicle registration card). System OCR auto-fills:
- Owner name
- VIN
- Plate number
- Make
- Model
- Manufacturing year

Advisor then enters manually:
- Mobile number (customer provides)
- Current mileage (entered when car arrives)
- Customer complaint(s)

> **Privacy/consent:** Moulkia contains personal data. Capture garage consent at onboarding ("allow GarageOS to extract vehicle owner details from Moulkia photos"), store only the extracted fields (not the image long-term), keep a privacy policy, and have a UAE legal advisor review before launch. Verify any RTA/UAEPDA requirements.

### Repeat customer — plate lookup
- Advisor enters/photographs **just the plate number**.
- System looks up the vehicle by plate → auto-fills owner, VIN, make, model, year from the existing record.
- Advisor enters only: mileage + complaint. No full Moulkia photo needed.

### Vehicle sold to a new owner
- Plate already exists in the database, but owner changed.
- Advisor can **edit owner name + mobile number**.
- Vehicle history stays linked to the plate (for maintenance reminders); contact info updates so future reminders go to the new owner.

---

## VAT (automatic)

System calculates VAT automatically; cashier never types it. Invoice shows VAT as a separate line (UAE 5%):

```
Labor:        AED 400
Parts:        AED 200
Subtotal:     AED 600
VAT (5%):     AED  30
Total:        AED 630
```

- VAT line always shown separately (compliance + customer clarity).
- Zero-entry accounting tracks VAT liability; Owner dashboard shows total VAT collected for filing.

---

## The job-card lifecycle (who touches it, in order)

1. Advisor creates job card (Moulkia OCR or plate lookup).
2. Advisor assigns to technician / shared pool.
3. Technician claims, diagnoses, reports findings.
4. Cashier sets price → estimate.
5. Customer approves (Approval #1) — no work before approval.
6. Technician works.
7. If extra problems found → cashier re-estimates → Customer approves (Approval #2) — work pauses until approved.
8. Technician completes → job card goes to cashier.
9. Cashier finalizes invoice (full edit power) + auto-VAT → sends to customer.
10. Customer notified "ready".
11. Customer pays (cash/card recorded) → vehicle delivered.
12. Automated maintenance reminders scheduled (see Workflow-Spec).
