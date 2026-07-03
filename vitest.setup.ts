// Vitest global setup — env precedence for tests.
//
// Mirrors prisma.config.ts: .env.local (dev DB) wins; .env (prod) is the
// explicit fallback for CI or operator-only test runs. Tests that hit a
// real DB (notably src/lib/__tests__/tenant-isolation.test.ts) MUST
// target the local DB on a dev workstation — otherwise running `npm
// test` would silently insert + delete rows on prod with the
// tenant-iso-test- id prefix.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const envLocal = path.resolve(".env.local");
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal });
} else {
  dotenv.config();
  process.stderr.write(
    "[vitest.setup] .env.local not found — tests will run against .env (production target)\n",
  );
}

// Force a single-connection pool in tests. The Prisma pg adapter's
// unnamed prepared-statement cache races across concurrent connections
// in the pool — producing `bind message supplies N parameters, but
// prepared statement "" requires 0` errors any time admin-isolation
// tests hit Promise.all queries. One connection = no race, slightly
// slower test runtime but bulletproof. Dev/prod URLs are unaffected.
const url = process.env.DATABASE_URL;
if (url) {
  const u = new URL(url);
  u.searchParams.set("connection_limit", "1");
  process.env.DATABASE_URL = u.toString();
}
