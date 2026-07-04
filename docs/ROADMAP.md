# GarageOS — Roadmap (What's Left)

*Your working map. When you feel scattered, open this. Do the top unfinished item. Ship it. Cross it off. Move down.*

---

## The one rule that keeps you un-scattered

**Finish and ship ONE thing before starting the next.** A half-built feature helps no one. A shipped feature — even a small one — is a piece of your shops' old software they can drop. Ship small, ship often, always know your *single* current task.

---

## Where you are right now (the honest baseline)

**Live and solid — don't touch, it's working:**
- ✅ Core app: 4 real shops running jobs (advisor-pricing workflow)
- ✅ Multi-tenancy: proven, tested, CI-enforced isolation
- ✅ Logo feature (shops upload logo → shows on customer invoices)
- ✅ Admin panel (Phases 1–6): view/create/manage all shops, reset passwords, deactivate — live
- ✅ Login brute-force protection (rate limiting)
- ✅ Database backup: nightly, encrypted, off-Supabase, **restore-tested**
- ✅ Inventory Phase 1a: parts catalog (add/list/low-stock, owner-only) — live
- ✅ Deploy pipeline: healthy, in sync (git = origin = live)

---

## RIGHT NOW — two quick safety items (do these first, ~15 min total)

These are small, they protect what's already live, and they've been deferred.

### ☐ 1. Confirm the file backup actually runs (2 min)
File backup (photos/logos/voice notes) was built but its first real run is tonight's cron on never-executed code.
- **Do:** manually trigger the backup workflow → confirm an encrypted archive lands in Backblaze under `files/`.
- **Why:** an untested backup is a hope. Confirm it works in daylight, not at 2am.

### ☐ 2. Rotate the exposed credentials (10 min)
Vercel token + DB password were exposed in chat.
- **Do:** rotate both. Keep the **pooler** URL format in Vercel (the direct-URL mistake caused the outage). Update all 3 Vercel scopes. Don't paste new values into chat.
- **Why:** real shops' data sits behind these.

---

## THE MAIN MISSION — Inventory / Parts + Purchasing

*Your shops use this daily in their old software. It's the #1 thing that lets them fully switch. Biggest build in the project — do it in shippable slices, one at a time.*

**Rule for every slice: build local → test yourself → ship → let a shop use it → then next slice.**

### ☐ Phase 1 — Catalog + Suppliers + Manual Stock
- ✅ **1a** — Parts catalog (add/list/low-stock, owner-only) — **SHIPPED**
- ☐ **1b** — Edit a part + manual stock adjustment (with reason)
- ☐ **1c** — Suppliers (add/edit/deactivate)
- ☐ **1d** — Wire low-stock to the owner dashboard (real data, not a hint)

### ☐ Phase 2 — Purchasing
- ☐ Purchase Orders to a supplier
- ☐ Receiving a PO → increases stock
- ☐ Purchase returns

### ☐ Phase 3 — Job Integration *(the delicate one — touches the LIVE workflow)*
- ☐ When a part goes on a job/estimate, draw from real inventory → stock decrements
- ☐ **Extra care here:** this touches the advisor-pricing flow your shops use daily. Test hard. Keep free-text parts working alongside.

### ☐ Phase 4 — Stock Ledger + Adjustments
- ☐ Running record of every stock movement (in/out/adjusted)
- ☐ Low-stock reporting

### ☐ Phase 5 — Inventory Reporting
- ☐ Stock statement, valuation, purchase reports

**After each phase ships → have karan or Arshad actually enter real data → watch what confuses them → that feedback shapes the next phase.**

---

## AFTER INVENTORY — the other shop-requested features

*Build these one complete feature at a time, same discipline. Order based on what your shops ask for most once inventory is done.*

### ☐ Accounting depth
Vouchers (payment/receipt/journal), bank reconciliation, financial statements (P&L, balance sheet, trial balance), VAT reports.

### ☐ Richer reporting
Customer/supplier aging, statements, job costing, job profit.

### ☐ Multi-branch
One company → multiple physical branches (stock per branch, branch reporting).

---

## BACKLOG — nice-to-haves, no rush

- ☐ PIN login for workers (labourers with no email) — *scoped, not built*
- ☐ Admin panel Phases 7–9 (analytics, platform settings, admin 2FA)
- ☐ Logo feature Phases E & F (tests + docs — internal hygiene)
- ☐ Clean up "Al Quoz Auto Care" test shop on production
- ☐ Nudge the 4 shops to change their starter passwords

---

## How to use this doc day-to-day

1. **Open this file.** Find the topmost unchecked ☐ item.
2. **That's your ONE task.** Don't start anything below it until it's shipped.
3. **Build it local → test it yourself → ship it → confirm live is healthy.**
4. **Check it off. Move to the next ☐.**
5. When a shop gives feedback, it goes to the top of the relevant section — real usage beats guessing.

**If you ever feel scattered again:** it's because more than one thing is half-done. Stop. Pick the one closest to shipping. Finish it. The feeling goes away.

---

## Your deploy checklist (every time you ship — this prevents the outage)

1. Migration to prod FIRST (if the change adds DB columns), then the code.
2. Build local → test yourself → then push.
3. After push: CI green? Vercel deployed? `/api/health` green? Normal login works?
4. Know the rollback commit before you push.
5. Keep the **pooler** URL format on Vercel — never the direct URL.

---

*Last updated: this session. Update the checkboxes as you go.*
