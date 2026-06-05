<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# GarageOS — Agent Instructions

Standing instructions for every coding session. `CLAUDE.md` imports this file. Read the
referenced docs before making decisions.

## What we're building
Phase 1 MVP of GarageOS: an AI-first garage operating system for the GCC. **UAE only**
at launch. WhatsApp-first. The principle: **AI proposes, humans confirm.** Radical
simplicity — max 3 actions per screen, no training needed, mobile-first, Arabic + English (RTL).

Specs in `/docs` (read before deciding):
- `GarageOS-GCC-Master.md` — vision, wedge, competition, risks (strategy)
- `GarageOS-Technical-Spec.md` — stack, data model, services, MVP scope (buildable contract; DoD §4, order §5)
- `Workflow-Spec.md` — the real 16-step garage flow + Tier 1/2/3 features
- `Role-Based-Dashboards.md` — the four roles, job card, Moulkia OCR, VAT
- `Job-Card-Data-Model.md` — every job-card field, by role + stage (schema/form source of truth)
- `PWA-and-Device-Setup-Spec.md` — install/device model (not yet in repo)

## Stack (do not deviate without asking) — free tiers chosen
- Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui
- Node API routes (Next route handlers)
- **PostgreSQL on Supabase free tier** (DB + object Storage), Prisma ORM
- **Auth.js (NextAuth v5)** — staff only; customers are passwordless (see rules)
- Anthropic API (Claude) for AI; WhatsApp Business Cloud API (Meta/BSP), self-serve Embedded Signup
- Payments: RECORD-ONLY (cash/card-POS) — no gateway. Subscription billing manual via isPilot (no Stripe yet)
- Supabase Storage for uploads (still local-disk in dev). Vercel hosting (not yet deployed)
- Tests: Vitest (unit). Playwright (e2e) not set up yet
- i18n/RTL: custom cookie-based dictionary (`src/i18n/`), en + ar (receptionist also hi/ur)

## KEY DECISIONS (these override defaults — do not reintroduce removed things)
1. **Payments: we do NOT process customer repair payments.** The garage uses its own cash
   drawer / bank POS. Our app only RECORDS payment as Cash or Card-POS, then writes the
   ledger entry. Never build a flow that processes the car owner's money. Customer invoice
   link is view-only.
2. **No Stripe yet.** Subscription billing is collected MANUALLY for the first ~30 garages
   (`Garage.isPilot` flag + admin switch). No payment gateway, no `STRIPE_*` env vars. Keep
   `Plan`/`Subscription` data; no keys/gateway.
3. **WhatsApp is self-serve.** Each garage connects its OWN number via Embedded Signup.
   Multi-tenant: each Garage stores its own WhatsApp number/credentials; inbound webhook
   routes by receiving number; outbound sends from THAT garage's number. Webhooks idempotent
   (dedupe on provider event id).
4. **AI chat = propose / confirm / handoff.** AI auto-handles routine messages (booking,
   status, invoice send, reminders). Anything involving price, quote, diagnosis, or a
   deadline must be confirmed by a human or replied "let me confirm with the team."
   Frustrated/low-confidence → hand off to advisor with a notification. Never let AI state a
   final price/commitment unconfirmed. Every AI call writes an `AiEvent` row (incl. `model`).
5. **Cashier/accounts sets prices, not the advisor.** Cashier has full invoice edit power
   (add/remove/adjust lines, notes). VAT (UAE 5%) is added automatically, shown as a
   separate line. Cashier records payment and marks paid.
6. **Two approval points.** Approval #1 before any work; Approval #2 if extra problems found
   mid-repair (work auto-pauses until approved). Approval recorded against the job card with
   timestamp.
7. **Moulkia OCR.** New customer → photo of Moulkia auto-fills owner, VIN, plate, make,
   model, year. Repeat → plate lookup auto-fills from record. Vehicle sold → advisor can
   edit owner name + mobile. Capture consent at onboarding; store only extracted fields;
   legal review before launch.
8. **Four roles, per branch:** Owner (all branches, billing, reports), Advisor (creates
   jobs/assigns, sends estimates — NOT prices), Technician (claim + workshop mode, no
   pricing), Cashier (sets price + invoice + VAT + payment record). Billing is per branch;
   each branch has own staff/WhatsApp/queue; owner sees branches aggregated.

## Rules
- Work in SMALL steps. After each: it runs, it's committed, it has a test.
- Never invent a different library when the spec names one.
- Ask BEFORE: installing a new dependency, changing the schema, or touching
  auth/payments/WhatsApp credentials.
- All money is Prisma `Decimal`, NEVER `Float` (accounting integrity).
- AI intake is propose-confirm: it writes a `Booking` row, never auto-creates a JobCard.
- Invoice keeps `clearanceStatus` + `qrPayload` from day one (KSA/ZATCA hook; UAE no
  clearance yet); invoice lines are a SNAPSHOT; numbering gapless & per-garage
  (`@@unique([garageId, number])`).
- Accounting is zero-entry: `LedgerEntry` rows generated by services, never by hand.
- Copilot is read-only and ALWAYS scoped to the owner's `garageId` — no raw SQL.
- Secrets in `.env` (git-ignored) — never in code, never committed.
- Max 3 primary actions per screen. Mobile-first. Arabic + English (RTL correct).

## How we work
1. I give you ONE focused task referencing a spec file.
2. You PLAN first — show the plan, no code yet.
3. I approve/correct the plan.
4. You implement that one step; tell me how to verify it runs.
5. I run it; we commit when green; then next task.

Do NOT build whole tiers or "everything in the spec" at once.

## Build order (Phase 1)
Scaffold + Prisma schema → auth + 4 role-routed home screens → job card (Moulkia OCR +
plate lookup) → advisor assign + technician claim queue → estimate + Approval #1 → work +
Approval #2 (auto-pause) → cashier invoice + auto-VAT + payment record → WhatsApp
(multi-tenant, propose/confirm) → owner dashboard + copilot (read-only) → maintenance
reminders → usage meter + RTL + instrumentation.

Definition of Done: `docs/GarageOS-Technical-Spec.md` §4.

## Not in Phase 1
KSA/ZATCA, Stripe/automated billing, marketplace, fleet, white-label, multi-country VAT,
full offline sync, native apps. Park these.
