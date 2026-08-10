// Vitest global setup — env precedence for tests.
//
// Rewritten 2026-08-10 to match prisma.config.ts's stricter rule: no
// fallback to .env exists anymore, because that fallback was the
// mechanism by which absence of .env.local silently pointed a Node
// process at Production. Tests that hit a real DB (notably
// src/lib/__tests__/tenant-isolation.test.ts) MUST target the local
// dev DB — otherwise running `npm test` would insert + delete rows
// on prod under the tenant-iso-test- id prefix.
//
// Rule:
//   1. If DATABASE_URL is already set in process.env → trust the
//      caller (CI provides one via secrets; a shell wrapper can set
//      one for a one-off run).
//   2. Else, load .env.local. It must exist AND must set DATABASE_URL
//      to something local. A hosted host is refused.
//   3. If none of the above → hard fail. Better a red suite than a
//      test suite silently touching customer data.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

if (!process.env.DATABASE_URL) {
  const envLocal = path.resolve(".env.local");
  if (fs.existsSync(envLocal)) {
    dotenv.config({ path: envLocal });
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "[vitest.setup] No DATABASE_URL resolved.\n" +
    "  Create .env.local with a localhost DATABASE_URL (see AGENTS.md,\n" +
    "  canonical port triple 51213 / 51214 / 51215), then re-run.\n" +
    "  There is NO fallback to .env — that fallback used to silently\n" +
    "  point tests at Production and has been removed.",
  );
}

if (url.includes("supabase.co") || url.includes("supabase.com")) {
  throw new Error(
    `[vitest.setup] DATABASE_URL points at a hosted DB (${new URL(url).host}).\n` +
    "  Tests must run against the local dev DB — running the tenant-\n" +
    "  isolation suite against Prod would insert + delete customer rows.\n" +
    "  Restore .env.local to the local Prisma dev proxy URL and re-run.",
  );
}

// Force a single-connection pool in tests. The Prisma pg adapter's
// unnamed prepared-statement cache races across concurrent connections
// in the pool — producing `bind message supplies N parameters, but
// prepared statement "" requires 0` errors any time admin-isolation
// tests hit Promise.all queries. One connection = no race, slightly
// slower test runtime but bulletproof. Dev/prod URLs are unaffected.
const u = new URL(url);
u.searchParams.set("connection_limit", "1");
process.env.DATABASE_URL = u.toString();
