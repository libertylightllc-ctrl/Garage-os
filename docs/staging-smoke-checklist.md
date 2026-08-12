# Staging smoke checklist

**When:** every time you're about to promote `main → production`.
**Where:** `staging.garageos.shop` (or the Vercel commit alias if custom domain isn't wired yet — see `deploy-runbook.md`).
**Password for all five users:** `password`.

If a row breaks: stop, do NOT promote, fix on `main`, re-run this checklist on the new commit.

This also spec's the Tier 2 Playwright suite — anything a human ticks here, the machine must tick before the promotion gate opens.

---

## 1. Sign in as each role — every page loads without error

For each role: sign in, click each primary tab, then each item in the More sheet on mobile (or the desktop side nav). Confirm the page renders, no red error boundary, no obviously-broken layout. Data can be sparse; the check is that the route resolves.

| Role | Email | Pages to load |
|---|---|---|
| **Owner** | `owner@demo.garage` | Dashboard · Jobs · Intake · Inventory · Analytics · Branches · Bays · Team · Hours · Suppliers · Purchasing · **Accounts** · Billing · Ledger · WhatsApp |
| **Advisor** | `advisor@demo.garage` | Jobs · Estimates · Chats · Parts · Bookings · Vehicles · Reminders · WhatsApp |
| **Tech** | `tech@demo.garage` | Workshop |
| **Cashier** | `cashier@demo.garage` | Accounts · WhatsApp |
| **Master** | `master@demo.garage` | Advisor · Intake · Workshop · Estimates · Accounts · Vehicles · Bookings · Parts · Reminders · Chats · Bays · Suppliers · Purchasing · Inventory · Hours · WhatsApp |

---

## 2. Four critical flows — each end-to-end, on staging data

Use a distinctive plate for each run (e.g. `SMK-<yymmdd>-1` … `-4`) so you can find your own test rows again and so runs don't collide.

### Flow A — Intake creates a job

Sign in as **Advisor**. Book an intake: unique plate, unique customer name + phone. Submit.
- [ ] Land on the new job card, plate matches what you typed.
- [ ] Job appears in `/advisor` Jobs list.

### Flow B — Estimate becomes an approved quotation

On the same job, add ONE line (any part, priced). Send to customer. Open the customer link in a new tab (paste the `/c/estimate/<token>` URL). Tap Approve.
- [ ] Customer page confirms approval.
- [ ] Back on `/advisor/estimates`, the estimate shows APPROVED.

### Flow C — Invoice generates + records

Sign in as **Cashier**. On the same job's approved estimate, generate invoice. Record a cash payment for the full amount.
- [ ] Invoice detail page shows PAID.
- [ ] Owner's Ledger (`/owner/ledger`) shows a receivable + a payment row for this job.
- [ ] Profit card renders on `/invoices/<id>` (advisor/owner view), shows a real number OR the "labour rate not set" CTA if no rate configured.

### Flow D — Hand-typed part → Request for Quotation to a supplier ⚠️

**This is the flow whose regression cost two shops. Do not skip.**

Sign in as **Advisor**. On a fresh job (new plate), add a line with a **hand-typed** part description (no catalog link — type the description in freehand, no partId). Send the estimate. Approve it via the customer link (like Flow B).

Now as **Owner** (or **Master**), go to `/owner/purchasing`, convert the approved estimate to a Purchase Order draft, and assign a supplier.
- [ ] The document header reads **Request for Quotation**, not Purchase Order.
- [ ] The hand-typed part appears on it, with the description you wrote.
- [ ] There is **no price** on that line — the whole point is asking the supplier what it costs.
- [ ] The send-to-supplier action (WhatsApp draft or PDF) works — the wa.me link opens, or the PDF renders.

---

## 3. Sign-off

- [ ] All five roles' pages loaded green.
- [ ] Flows A, B, C, D all completed as written.
- [ ] Test rows are identifiable by plate prefix for cleanup / audit.

**Only then promote:**
```bash
git checkout production && git pull --ff-only origin production && git merge --ff-only main && git push origin production
```
