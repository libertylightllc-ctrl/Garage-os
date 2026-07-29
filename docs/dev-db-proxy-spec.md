# Dev DB proxy — pinned local Postgres for GarageOS

The canonical spec for how the local development database runs. Any comment
in `.env.local`, `.env.example`, or `AGENTS.md` that disagrees with this
document is wrong; fix the comment, not the pin.

**Canonical port triple:** `51213` (Prisma dev proxy) / `51214` (Postgres TCP)
/ `51215` (shadow Postgres). `.env.local`'s `DATABASE_URL` uses `:51214`.

**Rule: restart the Next dev server after ANY change to `.env.local`.**
Next reads `process.env.DATABASE_URL` once at boot; edits do not propagate
to a running process. Skipping this restart is the single most common
reason "the dev server started ECONNREFUSING everything" — the app is
still talking to the old port. Full explanation below under "Why the ports
appear cached in Next.js". This is the single most useful sentence in this
document.

## Why we needed this

Before this spec, port comments across `AGENTS.md`, `.env.example`, `.env.local`
header and `.env.local`'s actual URL disagreed with each other and with reality
— four different port numbers claimed to be "the local DB." Fresh subprocesses
(tsx, prisma CLI, vitest, migrate) failed with `ECONNREFUSED` while the running
Next dev server kept a working connection, because Next reads `process.env`
once at boot and never re-reads. The disagreement wasn't a Prisma bug — it was
that two `prisma dev` servers had accidentally been created (`garageos` and
`default`), each on different ports, and `.env.local` kept getting pointed at
whichever one had been touched most recently.

## The single invariant this pin depends on

**Exactly one `prisma dev` server exists on this machine, named `garageos`.**

`prisma dev` (v0.16.26) allocates ports deterministically from a fixed base
range. The first server on a fresh machine gets `51213` / `51214` / `51215`.
Additional servers get shifted ranges. As long as there is only ever one
server named `garageos`, those three ports are stable across restarts,
reboots, and reseeds — Prisma has nothing else to pick from.

The `--port` / `--db-port` / `--shadow-db-port` flags are **silently ignored**
by `prisma dev` in v0.16.26 (verified 2026-07-29 — passing `--port 55513
--db-port 55514 --shadow-db-port 55515` still produced 51213/51214/51215).
This spec does not rely on those flags. If a future Prisma version starts
respecting them, revisit `scripts/db-doctor.mjs`'s `CANONICAL` constant.

## npm scripts

- `npm run db:init` — one-shot: `prisma dev --name garageos --detach`.
  Only needed on a fresh install or after `prisma dev rm garageos`.
- `npm run db:dev` — the daily driver. Wrapper that runs `db:init` if the
  server doesn't exist yet, otherwise `prisma dev start garageos --detach`.
- `npm run db:doctor` — read-only verification. Exits **non-zero** on drift,
  printing the exact recovery command. Runs in <1s. Safe to invoke on
  session start.
- `npm run db:migrate` / `db:reset` / `db:seed` / `db:studio` — unchanged
  from before; all target `.env.local`'s `DATABASE_URL`.

## `db:doctor` — what it checks

Five gates, in order:

1. **No phantom servers.** Any `prisma dev` server other than `garageos`
   existing on this machine is a failure. Prints `npx prisma dev rm <name>
   --force` for each. (Any second server would shift `garageos`'s ports,
   breaking the pin.)
2. **`garageos` exists.** Prints `npm run db:init` if not.
3. **`server.json` ports match the canonical triple** (`51213` / `51214` /
   `51215`). Prints `npx prisma dev rm garageos --force && npm run db:init`
   on any mismatch.
4. **`.env.local` `DATABASE_URL` and `SHADOW_DATABASE_URL` point at the
   canonical ports.** Prints the exact `sed`-friendly change on drift.
5. **Something is actually listening on the DB port.** A TCP-connect probe
   against `127.0.0.1:51214`. The state file persists across a killed
   prisma-dev process, so gates 1-3 can be ✓ while the Postgres process is
   dead. This gate catches "config looks fine but Next crashes with
   ECONNREFUSED on every query." Prints `npm run db:dev`.

By design **read-only** — it does not auto-repair. Silent self-healing would
hide the exact class of drift this script exists to catch.

## The `server.json` state file

`prisma dev` stores each named server's port assignments in a per-user state
file:

- Windows: `%LOCALAPPDATA%\prisma-dev-nodejs\Data\garageos\server.json`
- macOS: `~/Library/Application Support/prisma-dev-nodejs/Data/garageos/server.json`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/prisma-dev-nodejs/Data/garageos/server.json`

`db:doctor` reads this file directly. If the ports there disagree with the
canonical triple, the recovery is destructive (removes the DB data): `npx
prisma dev rm garageos --force && npm run db:init && npm run db:migrate &&
npm run db:seed`.

## Why the ports appear "cached" in Next.js after `.env.local` edits

`process.env.DATABASE_URL` is a snapshot from process start. `src/lib/
pg-adapter.ts` reads it at module init time and opens a `pg` Pool against
that URL. Editing `.env.local` **does not** notify a running Next dev
server. Killing and re-running `npm run dev` is the only way to pick up
the new value.

That's not a bug; it's how `process.env` works everywhere. But it's the
reason a stale `.env.local` can look "fine" (Next stays connected) while
every fresh subprocess (`prisma`, `tsx`, `vitest`) fails to reach the DB.

## Recovery paths

### "Something is broken and I don't know what"

```bash
npm run db:doctor        # tells you exactly what's wrong
```

Follow the printed recovery commands. **If any of them edit `.env.local`,
restart the Next dev server afterwards** — otherwise Next is still holding
the old port in `process.env` and you'll see ECONNREFUSED on every DB call
until you do.

### "I want a fresh dev DB from scratch"

```bash
npx prisma dev rm garageos --force
npm run db:init
npm run db:migrate       # apply all migrations to the new empty DB
npm run db:seed          # Demo Garage + 4 staff + fixtures
npm run db:doctor        # confirm the ports match
```

Also restart the Next dev server after this — its Pool is pointing at the
old (dead) Postgres port.

### "There's a phantom server (`default`, `foo`, whatever) in `prisma dev ls`"

Delete it. Not tomorrow. Right now.

```bash
npx prisma dev rm <name> --force
npm run db:doctor
```

Any server other than `garageos` shifts the port allocation and can cause
`.env.local` to end up pointing at the wrong database.

## What this spec does NOT change

- No production behavior. `DATABASE_URL` in Vercel, `.env`'s prod value,
  the Supabase pooler — all untouched.
- No schema changes.
- No changes to `src/lib/pg-adapter.ts` or how the app reads
  `process.env.DATABASE_URL`.

Local tooling only.
