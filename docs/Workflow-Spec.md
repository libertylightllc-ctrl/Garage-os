# GarageOS — Real-World Workflow Spec

The operational details a basic "happy path" build misses. Organized by priority so you build the right things now and don't disappear into months of edge cases.

**The discipline:** Build the "BUILD NOW" items. Ship to garages. Let real advisors tell you which "WATCH" items actually bite before building them. Don't build the whole list up front.

---

## THE STANDARD FLOW (16 steps — the real garage process)

The clean process as described by the operator. The trunk; branch points connect to the Tier items below. Note: the **advisor sets prices** (REVERSED 2026-06-23 after observing real pilot shops — previous rule was "cashier sets prices"; see AGENTS.md Key Decision #5), the **cashier owns invoicing + payment**, and there are **two approval points**.

| # | Step | Role |
|---|---|---|
| 1 | Customer arrives (appointment/walk-in), describes problem | Customer |
| 2 | Advisor inspects; gathers details. New car → Moulkia OCR (owner, VIN, plate, make, model, year). Repeat car → plate lookup. Enters mobile, mileage, complaint | Advisor |
| 3 | Advisor assigns job to technician (or shared pool) | Advisor |
| 4 | Technician does deep diagnosis, identifies actual fault | Technician |
| 5 | Technician reports findings (parts + labor) to advisor | Technician |
| 6 | **Advisor sets the price** → estimate prepared | Advisor |
| 7 | Estimate sent to customer over WhatsApp by the advisor — **Approval #1**, no work before approval | Customer |
| 8 | Job card opens, technician starts work | Technician |
| 9 | Mid-work: technician finds **extra problems** not in estimate | Technician |
| 10 | Technician reports extra work to advisor → **advisor re-estimates** | Advisor |
| 11 | New estimate to customer — **Approval #2**, **work pauses until approved** | Customer |
| 12 | Technician finishes all approved work, marks complete | Technician |
| 13 | Job card → cashier. Cashier finalizes invoice (full edit power) + **auto-VAT** | Cashier |
| 14 | Customer notified "ready" (WhatsApp), invoice sent | System/Cashier |
| 15 | Customer pays (cash / card-POS recorded, not processed); vehicle delivered | Cashier/Customer |
| 16 | **Automated maintenance reminders** scheduled (see below) | System |

### The two approval points (don't flatten these)
- **Approval #1 (step 7):** before any work.
- **Approval #2 (step 11):** when extra problems are found mid-repair — work auto-pauses until the customer approves the new estimate. A real garage hits this constantly; it's the dispute shield.

### Step 16 — automated maintenance reminders
System tracks mileage-in and service date, then auto-sends WhatsApp reminders. Oil is special — the advisor records the **oil type** and the reminder timing follows it:
- **Oil (5,000 km type):** remind at **2 months** — message asks customer to check mileage (due at 5,000 km driven).
- **Oil (10,000 km type):** remind at **4 months** — check mileage (due at 10,000 km).
- **Battery:** 6 months · **Tire rotation:** 6 months · **Brakes:** 6 months · **AC service:** 6 months · **Air filter:** 12 months · **Coolant/transmission:** 12 months.

Reminder asks the customer to check their own mileage rather than assuming distance driven.

**Build the backbone as the trunk. Build the branches below as branches — don't flatten reality into the straight line.**

---

## TIER 1 — BUILD NOW (the basic loop lies without these)

### 1. Pause / Resume a job
A started car often can't proceed — waiting for a part, or waiting for customer approval. It's not "done" and not actively worked on.
- Add states: **Paused — waiting for part** and **Paused — waiting for approval**.
- Paused cars leave the active in-progress list but stay visible (and clearly flagged) so nothing looks abandoned.
- Resuming returns it to the technician's active work.

### 2. Quote approval before extra work (reputation + legal)
Tech inspects, finds more problems, the price goes up. Work must NOT continue until the customer approves the new amount.
- When a quote increases, job auto-pauses → "waiting for approval".
- Approval request goes to the customer (WhatsApp) — propose/confirm, advisor sends it.
- No approval = no work. Approval recorded against the job card with timestamp.
- This prevents "you did work I never agreed to" disputes. Non-negotiable.

### 3. Part request loop (biggest cause of real delay)
Tech taps "need part X". Define what happens next:
- Request goes to advisor/parts person.
- In stock → fulfilled, job continues. Not in stock → must order, job auto-pauses "waiting for part".
- Tech and advisor can see status of the request (requested / ordered / arrived).
- Even a simple version of this is essential — it's where garages lose hours.

---

## TIER 2 — WATCH IN PILOTS (build only when a real garage hits the wall)

### 4. Multiple technicians on one car
Big jobs (engine + AC) may need two techs. Decide later: is a claim exclusive, or can a job have a primary + helpers? Don't assume one-tech-per-car forever.

### 5. Reassign / handover
Shift ends, break, wrong specialist — move a car to another tech WITHOUT dumping it back to the pool and losing its history/photos.

### 6. Priority / urgency in the queue
VIP, emergency, or fleet car losing money parked. A way to bump a car to the top instead of pure first-come-first-served.

### 7. Bays / ramps as a limited resource
A garage has N lifts. Eventually "in progress" is capped by physical space, not technician count. Model bays only if/when garages say the queue ignores reality.

### 8. Partial / deposit payments
Half now, half on pickup; cash for one, card for another. Extend "mark as paid" to handle partials and mixed methods — when garages actually ask.

### 9. Car ready but not collected
Done car taking up a bay, customer not answering. Add "ready — awaiting collection" + a nudge, if this turns out common (it usually is).

### 10. Out-of-stock / wrong part path
The ordered part is wrong or late — job stalls, customer needs telling. Build once the basic part loop (#3) is in and garages hit the messy cases.

---

## TIER 3 — CHEAP + HIGH VALUE (add when convenient)

### 11. Check-in photo prompt (dispute shield)
At check-in, PROMPT the advisor to photograph the car (existing scratches/dents). Protects the garage from "you damaged it" claims. Small effort, real payoff — your photo feature already exists, just prompt it at intake.

### 12. End-of-day open-jobs view
One screen for the owner/advisor before closing: what's unfinished, what's waiting on parts, what's waiting on the customer. One view, big peace-of-mind payoff.

---

## How to hand this to Claude Code

Build Tier 1 only, one item at a time, in order. Suggested first prompt:

> Read CLAUDE.md and the workflow spec. Implement Tier 1 item 1 (Pause/Resume) and item 2 (Quote approval before extra work). Add the paused states to the job card, auto-pause on a quote increase, and route the approval request through the propose/confirm WhatsApp flow. Don't build Tier 2 or 3. Plan first.

Then do item 3 (part loop) as its own step. Leave Tier 2/3 until pilots justify them.

---

## The trap to avoid

Every item in Tier 2 feels important when you imagine it. But imagining a problem is not the same as a garage having it. Build Tier 1, ship, and let real usage — not this document, not your imagination — decide what's next. The roadmap is real garages talking, not a longer feature list.
