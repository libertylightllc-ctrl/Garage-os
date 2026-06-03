# GarageOS

Phase 1 MVP — a GCC garage operating system. **UAE only. WhatsApp-first. AI proposes, humans confirm.**
Specs live in [`docs/`](docs/) (Technical Spec is the buildable contract; Master Plan is strategy).
Agent rules: [`AGENTS.md`](AGENTS.md) (mirrored to `CLAUDE.md`).

## Stack (free tiers)
Next.js 16 (App Router) · TypeScript · Tailwind v4 · Prisma 7 (driver-adapter, `@prisma/adapter-pg`) ·
PostgreSQL. Auth.js, Anthropic API, WhatsApp Cloud API, Stripe arrive in later build steps.

- **Local DB (free, no signup):** Prisma's bundled local Postgres via `npm run db:dev`.
- **Deploy DB (free tier):** Supabase (Postgres + object storage) — see [`.env.example`](.env.example).

## Run it locally
```bash
npm install
npm run db:dev      # starts local Postgres; copy the DATABASE_URL/SHADOW_DATABASE_URL it prints into .env
npm run db:push     # create the tables (see "Migrations" note below)
npm run db:seed     # 1 demo garage, 4 staff logins, 2 customers, 1 vehicle
npm run dev         # http://localhost:3000  -> /login ; /api/health is a JSON probe
npm test            # Vitest
```
Demo staff logins (password `password`): `owner@`, `advisor@`, `tech@`, `accountant@demo.garage`.
> The local Prisma Postgres port is **dynamic** — if you restart `db:dev`, re-copy the printed
> `DATABASE_URL` into `.env`.

## Migrations note
We use `prisma db push` for local dev because the local Prisma Postgres **shadow** database (used by
`prisma migrate dev`) currently errors with `P1017`. The formal migration baseline (`prisma migrate dev`)
will be generated against the real Supabase DB, which provides a proper shadow database. Schema is the
source of truth either way.

## Build order
See [`docs/GarageOS-Technical-Spec.md`](docs/GarageOS-Technical-Spec.md) §5.
**Step 1:** scaffold + Prisma schema + DB + running app + first test. ✅
**Step 2:** Auth.js (Credentials/JWT) with 4 staff roles + role-routed home screens + seed. ✅
**Step 3:** JobCard core + advisor one-tap timeline (ARRIVED→DELIVERED, +ON_HOLD/CANCELLED/rework). ✅
**Next: Step 4** — Technician workshop mode (photo / voice / request part / finish).
