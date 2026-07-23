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
- `PWA-and-Device-Setup-Spec.md` — install/device model (manifest + SW shell, A2HS prompt, shared-tablet tech login, admin onboarding)

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
5. **Advisor prices estimates; cashier invoices + collects payment.** (Reversed
   2026-06-23 after observing real pilot shops — the previous rule was "cashier sets
   prices"; the workflow that actually plays out is: tech finishes diagnosis → ADVISOR
   prices the estimate and sends it to the customer over WhatsApp → CASHIER takes over
   on approval, generates the invoice and collects payment.) Concretely:
   - **Advisor** creates + edits estimate lines, sets prices, sends the estimate to the
     customer. Owns the customer relationship; never touches invoice or payment.
   - **Cashier** has full invoice edit power (add/remove/adjust lines, notes, discount).
     VAT (UAE 5%) is added automatically, shown as a separate line. Cashier records
     payment and marks paid. Cashier sees Approved estimates ready to invoice but cannot
     edit estimate lines.
   - **Owner** is allowed on both sides as override for single-person shops.
   - Permission rules in `src/lib/permissions.ts`: `ESTIMATE_CREATE_ROLES = [ADVISOR,
     OWNER, MASTER]` and `INVOICE_ROLES = [CASHIER, OWNER, MASTER]`. Send-to-customer
     (`SEND_ROLES`) stays open to advisor + cashier (+ owner/master).
6. **Two approval points.** Approval #1 before any work; Approval #2 if extra problems found
   mid-repair (work auto-pauses until approved). Approval recorded against the job card with
   timestamp.
7. **Moulkia OCR.** New customer → photo of Moulkia auto-fills owner, VIN, plate, make,
   model, year. Repeat → plate lookup auto-fills from record. Vehicle sold → advisor can
   edit owner name + mobile. Capture consent at onboarding; store only extracted fields;
   legal review before launch.
8. **Four roles, per branch (+ MASTER, added 2026-07-12):** Owner (all branches, billing,
   reports), Advisor (creates jobs/assigns, prices estimates, sends to customer — owns
   customer relationship), Technician (claim + workshop mode, no pricing), Cashier
   (invoice + VAT + payment record only — does NOT price estimates anymore; see Key
   Decision #5). Billing is per branch; each branch has own staff/WhatsApp/queue; owner
   sees branches aggregated.
   **MASTER** is an owner-created do-everything operational login: advisor + technician +
   cashier work under one account (full flow intake → estimate → invoice → payment). It
   lives in every operational guard (`requireAdvisor`, `requireTech`, the money arrays in
   `permissions.ts`). Home = `/advisor`.
   MASTER's `/owner/*` access is split by concern:
   - **Permitted (operational):** `/owner/bays`, `/owner/suppliers`,
     `/owner/purchasing`, `/owner/inventory`, `/owner/hours` and their child routes.
     Guards use `requireAnyRole(["OWNER", "MASTER"])`. MASTER runs the shop and needs
     to see stock, chase POs, know which bay a car is in, and read tech hours.
   - **Barred (financial + reporting + admin):** `/owner` (dashboard), `/owner/analytics`,
     `/owner/billing`, `/owner/ledger`, `/owner/branches`, `/owner/whatsapp`,
     `/owner/staff` (index). Guards stay strict `requireRole("OWNER")`.
   The MASTER vs OWNER boundary is pinned by tests at
   `src/lib/__tests__/master-owner-boundary.test.ts` (source-inspects each guard) and
   `src/config/__tests__/nav.test.ts` (pins the exact set of nav hrefs per role).
   A silent widening or narrowing of either surface fires those tests.

   **Opening a page to a role means opening its actions too.** A page guard
   and its action guards must match — every form on the page submits to
   an action, and if the page loads for a role the action rejects, the
   page becomes a TRAP: renders fine, throws "Not authorized" on every
   submit (shipped once as the 15-action gap on the MASTER-operational
   surfaces; caught only by human click, never by tests). Rule for the
   next MASTER page:
   1. Swap the page guard to `requireAnyRole(["OWNER", "MASTER"])` (in
      `src/lib/guard.ts`).
   2. Swap EVERY action the page's forms submit to from `requireOwner()`
      to `requireOperational()` (in `src/lib/action-guards.ts`).
   3. Extend `master-owner-boundary.test.ts` with the new action names
      in `OPERATIONAL_ACTIONS`, so a later revert fires the test.
   The three guard helpers today: `requireOwner()` (owner-only: finance,
   onboarding, WhatsApp connect), `requireOperational()` (OWNER + MASTER:
   inventory, purchasing, suppliers, parts imports), `requireAdvisor()` /
   `requireTech()` (already include MASTER).

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
- Never weaken, skip, or delete a test to force a pass. Fix the real cause.
- Regression halt: a previously-passing test going red outranks the current task. Stop and report.
- Inspection is not verification. If the surface is a browser or a printer, DRIVE it (screenshot, measure, print-preview) — "verified by reading the code" is not verified.
- Test against the deployment target. Vercel is UTC; Windows dev is Asia/Dubai. ANY change that renders a date or time must be verified under `TZ=UTC npm run dev` before declaring green.
- Investigate → build → human click. A report is not a build; a build is not verified. Features touching money, dates, guards, or the intake form ship only after AR has clicked the actual surface.
- Print surfaces: audit the ROOT LAYOUT and all parent layouts for fixed/floating elements before declaring a print page green. The page's own CSS is not the whole render tree — a `fixed`/`sticky` element in `src/app/layout.tsx` (or any nested layout) will paint on every printed page unless it carries `print:hidden`.

## Dev DB vs Prod DB — separated (2026-06-27)

**Default:** local dev hits a local Postgres. Production is reached ONLY by
explicit operator scripts. The 4 live shops' data is unreachable from `npm run
dev` / `npm test`.

Two env files:
- `.env.local` — git-ignored. `DATABASE_URL` = `postgres://...@localhost:51214/...`
  (the Prisma 7 bundled local Postgres). Loaded by:
  - Next.js dev server (`npm run dev`) — native precedence
  - `prisma.config.ts` (every `prisma` CLI command) — explicit shim
  - `prisma/seed.ts` — explicit shim
  - `vitest.setup.ts` (every test run) — explicit shim
- `.env` — git-ignored. `DATABASE_URL` = the Supabase Singapore pooler.
  Production credentials. Only loaded as a FALLBACK when `.env.local` is
  absent. Each fallback prints a `[prisma.config] .env.local not found …
  production target` warning to stderr so a missing-`.env.local` mistake
  is loud.

NPM scripts targeting the local DB (all read `.env.local`):
- `npm run db:dev` — start the local Postgres (port 51214 + shadow 51215)
- `npm run db:migrate` — `prisma migrate dev` against local
- `npm run db:reset` — wipe local + reapply migrations (needs explicit consent)
- `npm run db:seed` — populate local with Demo Garage + 4 demo users
- `npm run db:studio` — Prisma Studio on local

Production targets — explicit, intentional:
- `npx prisma migrate deploy` — runs from the Vercel build step; manually
  invoked locally with `.env.local` removed/renamed temporarily. Hand-write
  the migration SQL when possible; do NOT use `prisma migrate dev` against
  prod.
- `scripts/create-garage.ts`, `scripts/delete-garage.mjs`, etc. — operator
  one-offs. They use `import "dotenv/config"` directly (NOT the prisma.config
  shim) so they always hit prod. Read the script + confirm DATABASE_URL host
  in the comment header before running.
- `db:push` is still in package.json but should NEVER target prod — schema
  changes need a migration file.

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
