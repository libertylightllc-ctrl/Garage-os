// Self-healing local dev DB preflight (AR 2026-08-21 Batch 4).
//
// The Prisma-dev local Postgres server drops connections ~once per
// hour on this machine with "Server has closed the connection" /
// "Connection terminated unexpectedly" / ECONNRESET. The manual
// playbook has been:
//   1. npx prisma dev rm garageos --force
//   2. npm run db:init
//   3. wait for port 51214
//   4. apply migrations
//   5. re-verify + re-run
//
// This script codifies that. Runs before `npm test` via the pretest
// hook and is idempotent — hitting it against a healthy DB is a
// fast no-op (one SELECT 1 + exit).
//
// Not wired to CI. CI uses a fresh Postgres per run; the flake is
// specific to Prisma 7's bundled `prisma-dev` on Windows/WSL. This
// script silently skips itself when the local DB URL doesn't point
// at the prisma-dev port triple.

import pg from "pg";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Load .env.local — this script runs before Vitest boots, so nothing
// else has populated DATABASE_URL yet. Manual parse (dotenv isn't a
// runtime dep for the app; a hand-roll is smaller than a dep).
function loadDotEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/i.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnvLocal();

const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 51214;
const CONNECT_TIMEOUT_MS = 4000;
const PORT_WAIT_MAX_MS = 30_000;

function log(msg) {
  process.stdout.write(`[db-preflight] ${msg}\n`);
}
function warn(msg) {
  process.stderr.write(`[db-preflight] ${msg}\n`);
}

/** Try one SELECT 1 against the local Postgres. Resolves to `true`
 *  when reachable + responsive, `false` on any error (connection
 *  refused, auth failure, query timeout). */
async function pingLocal() {
  const c = new pg.Client({
    host: LOCAL_HOST, port: LOCAL_PORT,
    user: "postgres", password: "postgres", database: "template1",
    ssl: false, connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await c.connect();
    await c.query("SELECT 1");
    await c.end();
    return true;
  } catch {
    try { await c.end(); } catch { /* ignore */ }
    return false;
  }
}

/** Poll for port availability. Prisma-dev's server takes 1-3s to
 *  finish binding after `prisma dev` returns. */
async function waitForLocal(maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await pingLocal()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  return r.status === 0;
}

/** Apply every migration on disk against the local DB via a direct
 *  pg client. Records applications in _prisma_migrations so Prisma
 *  agrees the DB is in sync. Handles CREATE INDEX CONCURRENTLY
 *  (splits statements) and $$-quoted function bodies (single
 *  execute). Same shape as the throwaway pg-apply-all.mjs used
 *  through this session. */
async function applyMigrations() {
  const c = new pg.Client({
    host: LOCAL_HOST, port: LOCAL_PORT,
    user: "postgres", password: "postgres", database: "template1",
    ssl: false, connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await c.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS _prisma_migrations (
        id                     VARCHAR(36) PRIMARY KEY,
        checksum               VARCHAR(64) NOT NULL,
        finished_at            TIMESTAMPTZ,
        migration_name         VARCHAR(255) NOT NULL,
        logs                   TEXT,
        rolled_back_at         TIMESTAMPTZ,
        started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        applied_steps_count    INTEGER NOT NULL DEFAULT 0
      )
    `);
    const migRoot = "prisma/migrations";
    const dirs = fs.readdirSync(migRoot)
      .filter((d) => fs.statSync(path.join(migRoot, d)).isDirectory())
      .sort();
    for (const dir of dirs) {
      const sqlPath = path.join(migRoot, dir, "migration.sql");
      if (!fs.existsSync(sqlPath)) continue;
      const sql = fs.readFileSync(sqlPath, "utf8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      const existing = await c.query(
        `SELECT id, finished_at FROM _prisma_migrations WHERE migration_name = $1`,
        [dir],
      );
      if (existing.rowCount > 0 && existing.rows[0].finished_at) continue;

      const usesDollarQuote = sql.includes("$$");
      const statements = usesDollarQuote
        ? [sql]
        : sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
      for (const stmt of statements) await c.query(stmt);
      await c.query(
        `INSERT INTO _prisma_migrations
           (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES (gen_random_uuid()::text, $1, NOW(), $2, NULL, NULL, NOW(), 1)`,
        [checksum, dir],
      );
      log(`applied ${dir}`);
    }
  } finally {
    await c.end();
  }
}

async function main() {
  // Bail early if the caller isn't pointed at prisma-dev — this
  // script has nothing useful to do against staging / prod / a
  // Docker Postgres.
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes(`localhost:${LOCAL_PORT}`) && !url.includes(`127.0.0.1:${LOCAL_PORT}`)) {
    log(`DATABASE_URL doesn't point at prisma-dev (:${LOCAL_PORT}) — skipping.`);
    return;
  }

  if (await pingLocal()) {
    log("healthy — no action needed.");
    return;
  }

  warn("local DB unreachable — rebuilding prisma-dev server...");
  // rm may fail if the server was never created; that's fine.
  run("npx", ["prisma", "dev", "rm", "garageos", "--force"]);
  if (!run("npx", ["prisma", "dev", "--name", "garageos", "--detach"])) {
    warn("prisma dev init failed. Investigate manually with `npm run db:doctor`.");
    process.exit(1);
  }
  const up = await waitForLocal(PORT_WAIT_MAX_MS);
  if (!up) {
    warn(`prisma-dev not accepting connections after ${PORT_WAIT_MAX_MS}ms.`);
    process.exit(1);
  }
  log("prisma-dev is up — applying migrations...");
  await applyMigrations();
  const ok = await pingLocal();
  if (!ok) {
    warn("healed the port but couldn't ping — investigate manually.");
    process.exit(1);
  }
  log("healed and healthy.");
}

main().catch((e) => {
  warn(`unexpected: ${e?.message ?? e}`);
  process.exit(1);
});
