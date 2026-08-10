// scripts/lib/target-prod.mjs
//
// Side-effect module. `import "./lib/target-prod.mjs";` before any
// `../src/lib/prisma` import in an operator script → the script
// explicitly opts into Production.
//
// Contract:
//   1. Load .env (repo root). This file carries PROD_DATABASE_URL and
//      PROD_DIRECT_URL — renamed from DATABASE_URL/DIRECT_URL after
//      the 2026-08-10 postmortem so no Node process can find a
//      Production URL by falling back to .env with the well-known name.
//   2. Require PROD_DATABASE_URL. Absent → throw so the script cannot
//      run against a dev DB (which its logic assumes is Prod). Absence
//      is the loud, visible failure the operator sees instead of a
//      silent misaimed write.
//   3. Set process.env.DATABASE_URL from PROD_DATABASE_URL so downstream
//      code (Prisma client, pg driver) that reads DATABASE_URL sees
//      the Prod value. Same for DIRECT_URL if PROD_DIRECT_URL is set.
//   4. Print an unmissable stderr banner naming the target host so the
//      operator has a last-chance visual check before any query fires.
//
// Import order matters: this module MUST appear BEFORE `../src/lib/prisma`
// in the import list. ES modules evaluate in declaration order, so a
// leading side-effect import runs before the prisma client is
// instantiated (Prisma reads DATABASE_URL from process.env at client
// construction, not lazily).
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const envPath = path.resolve(".env");
if (!fs.existsSync(envPath)) {
    throw new Error(
        "target-prod: .env not found in repo root. This operator script " +
        "requires Prod credentials in .env (PROD_DATABASE_URL, " +
        "PROD_DIRECT_URL, AUTH_SECRET).",
    );
}
dotenv.config({ path: envPath });

const prodUrl = process.env.PROD_DATABASE_URL;
if (!prodUrl) {
    throw new Error(
        "target-prod: PROD_DATABASE_URL is not set in .env. " +
        "This env var was renamed from DATABASE_URL on 2026-08-10 so that no " +
        "Next.js dev server or Prisma CLI could pick up Prod credentials by " +
        "falling back to .env. Operator scripts must use the new name.",
    );
}

// Set both DATABASE_URL and DIRECT_URL so the Prisma client (which reads
// DATABASE_URL) and any migration invocation (which reads DIRECT_URL for
// session-mode connections) see Prod values. If PROD_DIRECT_URL isn't set,
// DATABASE_URL is fine for both — DIRECT_URL is only strictly required for
// operations that use advisory locks / long transactions.
process.env.DATABASE_URL = prodUrl;
const prodDirect = process.env.PROD_DIRECT_URL;
if (prodDirect) process.env.DIRECT_URL = prodDirect;

// Print the target host on stderr so the operator has a last visual
// check. Deliberately NOT hidden behind a debug flag — this is the
// last chance to Ctrl-C before mutating Prod.
let host = "(unparseable)";
try { host = new URL(prodUrl).host; } catch { /* leave placeholder */ }
process.stderr.write(`\n[target-prod] ⚠  Script targeting PRODUCTION: ${host}\n\n`);
