// Prisma config — schema + migrations location + which DB to talk to.
//
// Env-loading rule (added 2026-06-27 as part of dev/prod DB separation):
//   1. If .env.local exists → load it. This is the dev workstation case.
//      Hits the localhost Prisma Postgres on port 51214. Never touches
//      production data.
//   2. Else → load .env. This is the operator-script case (prod migrate
//      deploy, create-garage.ts, etc.). Warn so it's obvious in logs
//      which DB the next operation will target.
//
// IMPORTANT: this file IS the source of truth for "which DB does Prisma
// CLI talk to". For the Next.js dev server, Next reads .env.local
// natively (its precedence rules). The two systems agree:
//   - Dev: .env.local present → Next + Prisma CLI both target local.
//   - Prod operator: .env.local absent → both fall back to .env.

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

const envLocal = path.resolve(".env.local");
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal });
  // Stay quiet on dev — the path is the safe default.
} else {
  dotenv.config();
  // Print to stderr (not stdout) so build pipelines don't choke on it.
  // The warning matters because the absence of .env.local means we're
  // about to talk to PROD — that should never happen by accident on a
  // dev workstation.
  process.stderr.write(
    "[prisma.config] .env.local not found — falling back to .env (production target)\n",
  );
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
