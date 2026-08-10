// Prisma config — schema + migrations location + which DB to talk to.
//
// Env-loading rule (rewritten 2026-08-10 as part of dev/prod isolation):
//
//   1. If DATABASE_URL is ALREADY set in process.env → use it verbatim.
//      This is the Vercel-build path (Vercel injects DATABASE_URL as an
//      env var, no files involved) AND the operator-script path (scripts
//      that import scripts/lib/target-prod.mjs before invoking Prisma
//      have already set DATABASE_URL from PROD_DATABASE_URL).
//
//   2. Else, load .env.local. This is the local dev-server path. The
//      URL there MUST be the localhost Prisma dev proxy. `.env.local` is
//      git-ignored per AGENTS.md.
//
//   3. If neither is set → throw. There is NO fallback to `.env` — the
//      old fallback was the mechanism by which an absent .env.local
//      silently pointed Next.js / Prisma CLI at Production. .env now
//      carries PROD_DATABASE_URL (renamed) which Prisma will never
//      pick up by that name.
//
// After the URL is resolved, guard against destructive Prisma CLI
// subcommands (migrate dev, migrate reset, db push) whenever the target
// looks like a hosted (Supabase) DB. Those subcommands drop tables,
// re-run migrations, or force-sync schema without generating a migration
// file — running any of them against Production is a total-loss action
// reachable by a single mistyped command. Only `migrate deploy` (which
// runs pre-declared migration files transactionally) is allowed against
// a hosted DB, and that path is exercised only by the Vercel build
// step and by scripts/prod-migrate.mjs.
//
// IMPORTANT: this file IS the source of truth for "which DB does Prisma
// CLI talk to". For the Next.js dev server, Next reads .env.local
// natively (its precedence rules). next.config.ts adds an extra guard
// that refuses to boot the dev server if the resolved DATABASE_URL is
// hosted.

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// ─── 1 & 2: resolve DATABASE_URL ────────────────────────────────────
if (!process.env.DATABASE_URL) {
  const envLocal = path.resolve(".env.local");
  if (fs.existsSync(envLocal)) {
    dotenv.config({ path: envLocal });
  }
}

const resolvedUrl = process.env.DATABASE_URL;
if (!resolvedUrl) {
  throw new Error(
    "[prisma.config] No DATABASE_URL resolved.\n" +
    "  - For local dev: create .env.local with a localhost Prisma dev proxy URL.\n" +
    "  - For operator scripts targeting Prod: import scripts/lib/target-prod.mjs\n" +
    "    before running Prisma so DATABASE_URL is set from PROD_DATABASE_URL.\n" +
    "  - There is NO fallback to .env — Prod credentials live under the\n" +
    "    PROD_DATABASE_URL name in .env by design (2026-08-10 rename).\n",
  );
}

// ─── 3: destructive-command guard against hosted DBs ────────────────
//
// Prisma CLI subcommands considered destructive when applied to a
// hosted DB (Prod or Preview). Any of these against Prod is a data-
// loss action; each has cost a real team a full outage at some point:
const DESTRUCTIVE_SUBCOMMANDS = [
  "migrate dev",     // creates + applies migration bypassing the shadow DB flow, DROPS tables
  "migrate reset",   // wipes ALL data + reapplies migrations
  "db push",         // force-syncs schema, silent data loss
];
function looksLikeHostedDb(url: string): boolean {
  return url.includes("supabase.co") || url.includes("supabase.com");
}
if (looksLikeHostedDb(resolvedUrl)) {
  // Reconstruct the subcommand from argv. Prisma CLI invocation puts
  // subcommand tokens at argv[2]+. Join to catch multi-word names.
  const invocation = process.argv.slice(2).join(" ");
  for (const sub of DESTRUCTIVE_SUBCOMMANDS) {
    if (invocation.startsWith(sub)) {
      const host = (() => { try { return new URL(resolvedUrl).host; } catch { return "(unparseable)"; } })();
      throw new Error(
        `\n[prisma.config] REFUSING TO RUN "prisma ${sub}" AGAINST HOSTED DB (${host}).\n` +
        `  Destructive Prisma subcommands (${DESTRUCTIVE_SUBCOMMANDS.join(", ")}) are blocked\n` +
        `  against hosted (Supabase) targets. They drop tables, wipe data, or\n` +
        `  force-sync schema without generating a migration file — reaching\n` +
        `  Prod that way costs the audit trail (invoiceSeq gap = VAT violation)\n` +
        `  or the whole DB (migrate reset).\n` +
        `\n` +
        `  For a Prod schema change: hand-write the migration SQL, then run\n` +
        `  \`npx prisma migrate deploy\` (only "deploy" is allowed against hosted).\n` +
        `  For a local schema change: point DATABASE_URL at the local dev proxy\n` +
        `  and re-run.\n`,
      );
    }
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prisma 7 removed `directUrl` from both schema.prisma and this
    // config type — the Datasource shape here is `{ url,
    // shadowDatabaseUrl }` and Prisma silently ignored the extra
    // field when we tried it.
    //
    // Migration URL is overridden at the vercel-build script level
    // instead: `DATABASE_URL="$DIRECT_URL" prisma migrate deploy &&
    // next build`. That prefix only re-binds DATABASE_URL for the
    // migrate invocation; the subsequent `next build` (and the
    // Next.js runtime) reads the parent process's DATABASE_URL,
    // which stays the transaction pooler (port 6543).
    //
    // DIRECT_URL env in Vercel points at the SAME pooler host on
    // port 5432 (session mode) — required because the transaction
    // pooler doesn't support advisory locks / prepared statements
    // that migrations depend on. See commit 5a2c49e for the incident.
    url: process.env["DATABASE_URL"],
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
