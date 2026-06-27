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
