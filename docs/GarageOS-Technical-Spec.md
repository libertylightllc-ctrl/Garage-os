# GarageOS — Technical Build Spec (Phase 1 MVP)

This is the spec you hand to an AI coding agent (Claude Code / Codex) or a developer. Phase 1 = **UAE only, propose-confirm AI, WhatsApp-first, 5–10 pilot garages.**

---

## 1. Recommended Stack (boring, hireable, fast to ship)

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js (React) + TypeScript + Tailwind** | One codebase for web + mobile-web; PWA covers "mobile-first" without app stores |
| UI components | shadcn/ui | Card-based, large touch targets, fast |
| Backend | **Next.js API routes / Node + TypeScript** (or NestJS if you prefer structure) | Same language front-to-back; AI agents write TS well |
| Database | **PostgreSQL** | Relational integrity for accounting; one DB, many roles |
| ORM | **Prisma** | Type-safe schema = fewer agent mistakes |
| Auth | Clerk or Auth.js | Role-based (5 user types) out of the box |
| Hosting | Vercel (app) + Neon/Supabase (Postgres) | Cheap to start, scales later; pick UAE/EU region for data residency |
| AI | **Anthropic API (Claude)** for intake, copilot, expense OCR | Tool use + vision |
| Messaging | **WhatsApp Business Cloud API (Meta)** | The primary customer surface |
| Voice | Deepgram / Whisper (STT) + TTS provider | Voice notes → text |
| Payments | Stripe or a UAE PSP (Telr/PayTabs/Network) | Layer-3 revenue + invoices |

> **Decision rule for the agent:** prefer the choice above unless you give it a reason to deviate. Consistency beats cleverness for an AI-built codebase.

> **Data residency (document it now):** the DB lives in a UAE/EU region, but Clerk, the Anthropic API, and WhatsApp all process PII *outside* the UAE. Keep a short DATA-RESIDENCY note recording where personal data lives and which third parties it crosses borders to — pilot garages' legal/IT will ask, and it informs the Customer/voice-note retention policy.

---

## 2. Data Model (Prisma-style, abbreviated)

> **Money rule (applies to every monetary field below):** use Prisma `Decimal`, **never `Float`**. Floats silently corrupt accounting totals — this is the whole reason we chose Postgres. Fields affected: `subtotal, vatAmount, total, unitPrice, lineTotal, cost, price, debit, credit, amount, costEstimate`.
> **Timestamps:** every model gets `createdAt` + `updatedAt`.

```
Garage         id, name, country(UAE), trn(vatNumber), branchOf?, settingsJson  // branchOf is a Phase-2 hook; Phase 1 is single-garage
User           id, garageId, role(OWNER|ADVISOR|TECH|ACCOUNTANT), name, phone, email, lang(ar|en)  // STAFF ONLY — has auth/login
Customer       id, garageId, name, phone, lang(ar|en), trn?, waId?  // passwordless, phone-keyed, created on first WhatsApp contact; NEVER logs in
Vehicle        id, customerId, make, model, year, plate, vin
Booking        id, garageId, customerId, vehicleId?, channel(WA|WEB|PHONE), rawText?, voiceNoteUrl?, photoUrls[],
               aiProposalJson?, status(PROPOSED|CONFIRMED|REJECTED), jobCardId?  // home for propose-confirm intake BEFORE a JobCard exists
JobCard        id, garageId, vehicleId, advisorId, bookingId?,
               status(ARRIVED|INSPECTION|ESTIMATE|APPROVED|REPAIR|INVOICED|DELIVERED|ON_HOLD|CANCELLED)
JobStep        id, jobCardId, type, photoUrl?, voiceNoteUrl?, transcript?, techId
Estimate       id, jobCardId, subtotal, vatAmount, total, status(DRAFT|SENT|APPROVED|REJECTED)
EstimateLine   id, estimateId, kind(LABOR|PART|FEE), partId?, description, qty, unitPrice, lineTotal, vatRate
Invoice        id, jobCardId, estimateId, number, customerTrn?, issuedAt, dueDate,
               subtotal, vatAmount, total, qrPayload, status(DRAFT|SENT|PAID|VOID),
               clearanceStatus(NA|PENDING|CLEARED)   // clearanceStatus + qrPayload exist now, used in KSA later
               @@unique([garageId, number])          // VAT requires gapless, per-garage sequential numbering
InvoiceLine    id, invoiceId, kind(LABOR|PART|FEE), description, qty, unitPrice, lineTotal, vatRate  // SNAPSHOT — invoice is a legal doc, never re-reads the estimate
Payment        id, invoiceId, amount, method, paidAt
Part           id, garageId, sku, name, qtyOnHand, cost, price
PartMovement   id, partId, jobCardId?, delta, reason
LedgerEntry    id, garageId, account, debit, credit, sourceType, sourceId  // auto-generated
WhatsAppThread id, customerId, waId, lastMessageAt
WhatsAppMessage id, threadId, direction(IN|OUT), template?, body?, waMessageId, status, payloadJson  // @@unique(waMessageId) for webhook idempotency
AiEvent        id, garageId, userId?, kind(INTAKE|COPILOT|OCR|RECEPTIONIST), model, sourceType?, sourceId?,
               tokensIn, tokensOut, costEstimate, latencyMs  // meters Layer-2 margin per garage / feature / MODEL
```

**Key design rules:**
- **Staff vs Customer are different tables.** `User` = the 4 staff roles, with login. `Customer` is passwordless and phone-keyed because the wedge is *the customer never installs an app and lives on WhatsApp*. Don't force customers through the auth provider.
- **`Booking` is where propose-confirm lives.** A customer's voice/photo/text and the AI proposal land here *before* anything is committed. An advisor confirming a `Booking` is what creates the `JobCard` (`Booking.jobCardId`). AI never auto-creates a JobCard.
- `Invoice.clearanceStatus` and `qrPayload` exist from day one even though UAE doesn't use clearance yet — this is the pluggable-VAT hook so KSA is config, not rewrite.
- **Invoice line items are a snapshot** (`InvoiceLine`), copied at invoice time — the estimate can change afterward; the legal invoice must not.
- **Invoice numbering is gapless and per-garage** (`@@unique([garageId, number])` + a per-garage counter). UAE VAT requires it. `customerTrn` is captured for B2B invoices.
- **AR aging needs dates:** `Invoice.dueDate` + `issuedAt` drive 🟢🟡🔴 (overdue = `dueDate` past; balance = `total − Σ Payment.amount`).
- Every accounting fact is a `LedgerEntry` generated by a service when a JobCard/Invoice/Payment/PartMovement changes. No manual entries.
- Every AI call writes an `AiEvent` so you can see per-garage AI cost vs. subscription (the margin trap). `model` is recorded because Opus-vs-Haiku is the single biggest cost lever.
- **Webhook idempotency:** WhatsApp (and later Stripe/PSP) redeliver events — dedupe on `waMessageId` / the provider event id before acting.
- **Object storage:** `photoUrl`/`voiceNoteUrl`/`photoUrls[]` imply a blob store (Supabase Storage or S3) — provision it in Step 1, it's not in the DB.

---

## 3. Services (the "AI does the thinking" layer)

1. **IntakeService** — input (voice transcript / photo / text) → Claude → structured proposal `{likelyIssue, suggestedServices[], urgency}`, persisted on a `Booking` row (`status=PROPOSED`). **Always returns a proposal for a human to confirm; never auto-commits.** Advisor confirmation flips the `Booking` to `CONFIRMED` and creates the `JobCard`.
2. **AccountingService** — subscribes to domain events, writes `LedgerEntry` rows. Produces AR/AP/P&L/balance-sheet views.
3. **VatService** — `buildInvoice(country)` strategy pattern. `UAEStrategy` now; `KSAFatooraStrategy` (clearance + crypto stamp + QR) added Phase 2 behind the same interface.
4. **WhatsAppService** — inbound webhook + outbound templates (booking, estimate approval, invoice, tracking link, payment link).
5. **CopilotService** — owner NL question → Claude with read-only DB tools → answer. No write access initially. **Tenant isolation is mandatory:** every query is scoped to the owner's `garageId` through a constrained, parameterized tool surface — do not let the model emit raw SQL against the whole DB (cross-tenant leak + injection risk). Phase 1 answers 3 canned, **single-garage** question types (see §4); cross-branch comparison is Phase 2.
6. **ExpenseOcrService** — supplier invoice photo → Claude vision → `{supplier, number, amount, vat, dueDate}` → AP entry.
7. **UsageMeter** — wraps every AI call and writes `AiEvent` (incl. `model`). Phase 1 **meters only**; per-tier quota *enforcement* (and the `Plan`/`Subscription` model it needs) is Phase 2 — DoD requires visibility, not a paywall.

---

## 4. Phase 1 MVP — Definition of Done

Ship only this. Everything else is Phase 2+.

- [ ] Auth with 4 **staff** roles (OWNER/ADVISOR/TECH/ACCOUNTANT); each lands on its own home screen. Customers are passwordless (WhatsApp/portal), not auth users.
- [ ] Customer: 3-button home, voice/photo/text booking → `Booking` (propose-confirm), vehicle history.
- [ ] Advisor: one-tap timeline ARRIVED→DELIVERED on a real job card.
- [ ] Technician: workshop mode — photo, voice note, request part, finish (no typing).
- [ ] Estimate → WhatsApp approval → Invoice (UAE VAT, correct layout, QR placeholder).
- [ ] Zero-entry: creating invoice/payment auto-writes ledger entries; AR shows 🟢🟡🔴.
- [ ] Owner: 5-metric dashboard + copilot answering 3 canned, single-garage question types from live data: (1) "Are we up or down this week?" (2) "How much profit this month?" (3) "Who owes us money?" (AR). Cross-branch comparison is Phase 2.
- [ ] Every AI call metered to `AiEvent`.
- [ ] Arabic + English UI (RTL correct).
- [ ] Hypotheses instrumented: booking time, first-job-card time, intake-acceptance rate.

**Explicitly NOT in Phase 1:** KSA/ZATCA, inventory accounting depth, AI receptionist, marketplace, fleet, white-label, multi-country VAT.

---

## 5. Build Order (so the agent always has a working app)

> **Day 0, parallel track (not a build step):** start **Meta Business verification + WhatsApp template approval** immediately. It has a multi-week, external lead time you don't control — if you wait until Step 6 to file the paperwork, you stall.

1. Repo + stack scaffold + Prisma schema + migrate. **Also in Step 1:** pin the test stack (**Vitest + Playwright**); wire **i18n/RTL *infrastructure*** (`next-intl`, `<html dir>`, logical CSS props like `padding-inline`) and provision **object storage** (Supabase Storage / S3). Translations themselves land progressively — but direction-awareness is architecture, not a late feature.
2. Auth + 4 staff-role-routed empty home screens (customers are passwordless, handled later).
3. JobCard core + advisor timeline (the spine). Decide rework loops now: `REJECTED` estimate → back to `ESTIMATE`; `ON_HOLD`/`CANCELLED` exits.
4. Technician workshop mode (photo/voice/part/finish).
5. Estimate + Invoice (snapshot lines, gapless numbering) + UAE VatService + ledger auto-entries + AR dates.
6. WhatsApp approve/invoice/pay loop (idempotent webhook via `waMessageId`).
7. IntakeService (propose-confirm) writing `Booking`, on the customer booking screen.
8. Owner dashboard + CopilotService (read-only, garage-scoped).
9. UsageMeter + `AiEvent` + remaining Arabic **translations** + instrumentation.

Each step ends with: it runs, it's committed, it's tested.
