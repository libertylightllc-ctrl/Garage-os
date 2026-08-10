// scripts/lib/target-local.mjs
//
// Side-effect module. `import "./lib/target-local.mjs";` before any
// `../src/lib/prisma` import in a fixture/seed script → the script
// explicitly opts into the local dev DB (Prisma dev proxy on
// localhost:51214, per AGENTS.md's canonical port triple).
//
// Contract:
//   1. Load .env.local (repo root). It carries the local DATABASE_URL.
//   2. Require DATABASE_URL to be set AND to look local. A hosted host
//      (supabase.co / supabase.com) means .env.local was tampered with
//      to point at Prod — refuse rather than seed fixture data into
//      real customer records.
//   3. Print a stderr line naming the local host so the operator can
//      still eyeball the target.
//
// Import order matters: this module MUST appear BEFORE any import of
// `../src/lib/prisma`. See target-prod.mjs for the reasoning.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const envLocalPath = path.resolve(".env.local");
if (!fs.existsSync(envLocalPath)) {
    throw new Error(
        "target-local: .env.local not found in repo root. Fixture/seed " +
        "scripts require the local dev DB — run `npm run db:init` and " +
        "restore your .env.local before retrying.",
    );
}
dotenv.config({ path: envLocalPath });

const url = process.env.DATABASE_URL;
if (!url) {
    throw new Error(
        "target-local: .env.local does not set DATABASE_URL. " +
        "Local fixture scripts require a local Prisma dev proxy URL " +
        "(see AGENTS.md canonical port triple 51213 / 51214 / 51215).",
    );
}

if (url.includes("supabase.co") || url.includes("supabase.com")) {
    throw new Error(
        `target-local: .env.local's DATABASE_URL points at a hosted DB (${new URL(url).host}). ` +
        "Fixture/seed scripts NEVER run against a hosted (Prod or Preview) DB. " +
        "Restore .env.local to the local Prisma dev proxy URL.",
    );
}

let host = "(unparseable)";
try { host = new URL(url).host; } catch { /* leave placeholder */ }
process.stderr.write(`[target-local] fixture script targeting LOCAL DB: ${host}\n`);
