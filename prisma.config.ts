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
    url: process.env["DATABASE_URL"],
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
