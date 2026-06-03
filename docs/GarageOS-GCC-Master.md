# GarageOS GCC — Master Plan (v2)

> **What changed from v1:** Added a competition/wedge section, promoted VAT/ZATCA from a bullet to a first-class workstream, added unit economics, converted "facts" into testable hypotheses, and narrowed Phase 1 to one country with design-partner garages. Vision and UX philosophy from v1 are preserved.

---

## 1. One-Line Pitch

The garage operating system where the AI does the thinking and the human only makes decisions — booking in under 30 seconds, no staff training, WhatsApp-first, built for GCC conditions and GCC tax law.

---

## 2. The Wedge (Why We Win)

The GCC garage-software market is **crowded**, not empty. Existing players include Sianty, GaragePlug, Motosync, MASS/MAGS, Autorox, SolveTech, Synergia, Easy-Garage, and InventicSoft. Most already advertise Arabic/English support, VAT-compliant invoicing, multi-branch dashboards, and (increasingly) an "AI assistant."

**Therefore these are table stakes, not differentiators:**
- Bilingual Arabic/English
- VAT-compliant invoices
- Multi-branch management
- "AI reads the complaint and suggests repairs"

**Our single defensible wedge — radical operability:**
- Booking in <30s with **voice/photo instead of forms**
- **Zero-training** advisor and technician interfaces (max 3 actions per screen)
- **WhatsApp as the primary surface** — customer never installs an app
- The product is judged on *how little the human has to do*, not on feature count

Everything in this plan must serve the wedge. If a feature does not reduce human effort, it is Phase 3 or later.

**Positioning statement:** "Other garage software gives you more screens. GarageOS gives you fewer decisions."

---

## 3. Core Philosophy (unchanged from v1)

1. No user should need training.
2. Maximum 3 actions visible on any screen.
3. Replace forms with voice, photos, and AI.
4. Mobile-first.
5. Arabic and English from day one.

> These are **design constraints**, not proven outcomes. See §9 for how each is tested.

---

## 4. Users & Interfaces

Five roles, one database, five completely different interfaces:

1. **Car Owners** — book, track, approve, pay (mostly via WhatsApp).
2. **Service Advisors** — single tap-through timeline.
3. **Technicians** — workshop mode: big buttons, photo, voice, request part, finish.
4. **Accountants** — review auto-generated entries, not manual bookkeeping.
5. **Garage Owners** — 5-metric dashboard + natural-language copilot.

---

## 5. Customer Experience

**Home screen — three buttons only:** My Vehicles · New Service · Ask AI.

**Booking:** speak, photo, or type → AI proposes Quick Estimate / Book Inspection / Emergency Assistance.

> **Reality check on AI intake:** clean inputs ("AC not cooling") are easy; real inputs are messy ("makes a noise sometimes when hot, my brother said maybe the belt"). The flow is **AI proposes, advisor confirms** — never AI auto-commits. There is always a graceful fallback to a human.

**Features:** vehicle history, "Garage Story" visual repair journey (received → inspection photos → repair → parts → QC → delivered), service reminders, warranty tracking, full WhatsApp flow (book, approve, invoice, track, pay) with no app install.

---

## 6. Staff Experiences

**Service Advisor — one-tap timeline:** Arrived → Inspection → Estimate → Approval → Repair → Invoice → Delivery.

**Technician — workshop mode:** Current Job · 📷 Add Photo · 🎤 Voice Note · 📦 Request Part · ✅ Finish. No typing.

---

## 7. Accounting & the VAT/Compliance Workstream (PROMOTED)

> In v1 "VAT" was one bullet. In Saudi Arabia it is the single hardest engineering + certification problem in the whole product. It now has its own workstream and it **reorders the roadmap**.

### 7.1 Zero-entry accounting
Ledger, AR (🟢 paid / 🟡 due soon / 🔴 overdue), AP, P&L, balance sheet, and inventory valuation are all generated automatically from job cards, invoices, payments, purchases, and inventory movements. No manual journal entries.

### 7.2 UAE VAT (Phase 1 launch market)
- 5% standard VAT, tax-compliant invoice layout, Arabic/English.
- Comparatively simple **today** but a UAE e-invoicing mandate is coming — design the invoice engine to be pluggable so a clearance step can be added later without a rewrite.

### 7.3 Saudi ZATCA / Fatoora (Phase 2 market — DO NOT launch KSA until this is done)
This is **not** "generate a VAT invoice." Phase 2 is real-time integration with the government:
- Real-time reporting to the Fatoora platform (B2C simplified invoices reported within 24h).
- **B2B invoices require clearance from ZATCA before they can be sent to the customer.**
- Every invoice needs a cryptographic stamp, a UUID, and an enhanced QR code with a digital signature (PKI / AES-256).
- Scope now reaches small garages: businesses above SAR 375,000 annual revenue must connect via a certified solution by **30 June 2026**.
- Penalties are real: SAR 5,000–50,000 per violation; up to SAR 10,000 per non-compliant QR code.

**Architectural consequence:** the invoicing module must be built as a **country-pluggable clearance pipeline** from day one — even though Phase 1 only ships the UAE plug — so adding the KSA Fatoora plug later is configuration, not surgery.

### 7.4 Smart expense capture
Photo of a supplier invoice → AI extracts supplier, invoice #, amount, VAT, due date → records the entry automatically.

---

## 8. Owner Dashboard & AI Copilot

**Dashboard — 5 metrics, tap for detail:** 💰 Revenue · 📈 Profit · 🚗 Cars Today · ⭐ Satisfaction · 📦 Inventory Health.

**Copilot — natural-language Q&A:** "How much profit this month?" · "Which branch is best?" · "Who owes us money?" Answers are generated against the live database (read-only at first; no write actions from the copilot until trust is established).

---

## 9. Claims → Testable Hypotheses

Every v1 "fact" is now a hypothesis with a pilot metric. Nothing here is proven until measured with real garages.

| v1 claim | Hypothesis (test in pilot) | Pass bar |
|---|---|---|
| "No training needed" | New advisor completes first real job card unaided | ≥80% within 15 min |
| "Book in <30s" | Median customer booking time, real devices | ≤30s median |
| "AI understands the issue" | AI intake proposal accepted by advisor without edit | ≥70% of clean cases; graceful fallback on rest |
| "Owner understands business in 10s" | Owner answers "are we up or down this week" from dashboard | ≤10s, correct |

---

## 10. Revenue Model & Unit Economics (NEW)

Seven layers from v1 are kept, but each now needs a cost-to-serve so price ≠ guess.

**Layer 1 — Subscription** (one-country launch pricing, revisit after pilot):
- Starter AED 199–299/mo — small garages
- Growth AED 399–599/mo — growing workshops
- Pro AED 799–1499/mo — large / multi-branch

**Layers 2–7:** AI usage (voice minutes, receptionist, WhatsApp convos), payment processing commission, parts marketplace commission, fleet per-vehicle, white-label setup+monthly, financing/insurance referrals.

### The economics that must be modeled BEFORE pricing is final
- **Layer 2 is a margin trap.** Voice AI, an always-on multilingual receptionist, and WhatsApp volume are real per-unit costs you pay whether or not the customer values them. A Starter garage running a 24/7 voice receptionist can cost more than its subscription. **Action:** meter AI usage, set per-tier included quotas, charge overages.
- **Per-tier gross margin** = subscription + commissions − (hosting + AI usage + WhatsApp + support). Must be modeled per tier before launch.
- **Missing in v1, required now:** CAC, monthly churn assumption, payback period. Cut any layer that can't show positive contribution margin in the model.

---

## 11. Launch Strategy (RE-SEQUENCED)

**Phase 1 — UAE only, 5–10 design-partner garages.** Job cards, estimates, invoicing (UAE VAT via the pluggable engine), WhatsApp booking/approval/invoice, customer management, AI booking (propose-confirm). Goal: prove the wedge and the four hypotheses in §9.

**Phase 2 — Deepen + enter KSA.** Zero-entry accounting, inventory, AI receptionist, reminders, **and the ZATCA/Fatoora clearance plug** (gates KSA go-live). Do not sell into KSA before this passes ZATCA certification.

**Phase 3 — Expand.** Parts marketplace, fleet management, white-label, advanced AI, remaining GCC countries (Bahrain, Oman, Qatar, Kuwait) each with their own VAT plug.

---

## 12. Design System (unchanged from v1)

Premium automotive theme, dark workshop mode, large touch targets, card-based, minimal text, heavy icons. **Four status colors only:** 🟢 complete · 🟡 waiting · 🔵 info · 🔴 urgent.

---

## 13. AI Capabilities (GCC-specific)

AI receptionist (Arabic, English, Hindi, Urdu) across phone/WhatsApp/web/booking. Vehicle intelligence tuned for GCC: AC failures, summer battery failures, sand/dust, cooling problems, fleet schedules.

---

## 14. Ultimate Goal

The operating system for every independent garage in the GCC — managing customers, vehicles, repairs, technicians, accounting, payments, VAT, inventory, communication, and business intelligence through one experience where the human makes decisions and the AI does the work.

---

## 15. Open Risks (kept visible on purpose)

1. **Crowded market** — survival depends entirely on the wedge being real, not on feature parity.
2. **ZATCA certification** — a hard external gate on KSA revenue; budget time and a certified-solution path.
3. **AI usage margin** — can silently turn a profitable account unprofitable; metering is not optional.
4. **Messy real-world intake** — the no-forms promise breaks if the propose-confirm fallback isn't excellent.
5. **Unproven UX claims** — "no training" is a hypothesis until a real advisor proves it in pilot.
