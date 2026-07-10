// One-shot prod migration helper. Derives the Supabase SESSION-pooler URL
// (port 5432, no pgbouncer) from the transaction-pooler DATABASE_URL in
// .env, because Prisma's migration engine needs session-level features
// (advisory locks, prepared statements) that the pgbouncer transaction
// pooler (6543) can't provide.
//
// The password never touches argv or stdout: we set DATABASE_URL in the
// child process env (dotenv in prisma.config.ts won't override an already
// -set var), and only ever print the host, never the full URL.
//
// Usage:  node scripts/prod-migrate.mjs status   (read-only)
//         node scripts/prod-migrate.mjs deploy   (applies pending migrations)

import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config(); // .env (since .env.local is renamed away for prod ops)

let raw = process.env.DATABASE_URL;
if (!raw) {
  console.error("[prod-migrate] no DATABASE_URL in .env");
  process.exit(1);
}

// Repair a malformed .env value. The prod .env's DATABASE_URL line was
// double-written at some point:  DATABASE_URL="postgres://...""  — with a
// duplicated key prefix and doubled trailing quote. Strip a leading
// `DATABASE_URL=` and any surrounding quotes so we get a clean URL.
raw = raw
  .replace(/^\s*DATABASE_URL\s*=\s*/i, "")
  .replace(/^["']+/, "")
  .replace(/["']+\s*$/, "")
  .trim();

const u = new URL(raw);
u.port = "5432";
u.searchParams.delete("pgbouncer");
u.searchParams.delete("connection_limit");
const sessionUrl = u.toString();

console.error(`[prod-migrate] target host: ${u.host}  db: ${u.pathname}`);
console.error(`[prod-migrate] (session pooler, port 5432 — safe for migrations)`);

const mode = process.argv[2] === "deploy" ? "deploy" : "status";
console.error(`[prod-migrate] running: prisma migrate ${mode}\n`);

// Prisma 7's migrate reads the URL from prisma.config.ts, which resolves
// process.env.DATABASE_URL. We set it in the child env to the clean
// session-pooler URL; prisma.config.ts's dotenv.config() will NOT
// override an already-set var (confirmed: "injected env (0)"), so the
// child uses our clean URL, not the malformed .env line.
const res = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["prisma", "migrate", mode],
  {
    encoding: "utf8",
    shell: true,
    env: { ...process.env, DATABASE_URL: sessionUrl },
  }
);
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
if (res.error) console.error("[prod-migrate] spawn error:", res.error.message);
console.error(`[prod-migrate] child exit code: ${res.status}`);
process.exit(res.status ?? 1);
