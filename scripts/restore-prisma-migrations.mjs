// Step 4 SAFETY NET — restore _prisma_migrations from the JSON backup.
//
// Reads backups/_prisma_migrations.before-baseline-reset.json,
// wipes the current _prisma_migrations table, and INSERTs every row
// from the backup. All inside one transaction — atomic.
//
//   node restore-prisma-migrations.mjs            # DRY-RUN (default, safe)
//   node restore-prisma-migrations.mjs --execute  # actually restore
//
// Optional flags:
//   --file <path>   Use a different backup JSON file (default:
//                   backups/_prisma_migrations.before-baseline-reset.json)
//   --url <url>     Override DATABASE_URL (useful for the direct URL)
//
// DRY-RUN mode connects to the DB, parses the backup, shows you what
// rows it WOULD insert + the parameterized INSERT it'd run, but does
// NOT touch any data. Run dry-run first to confirm the script works.

import "./lib/target-prod.mjs";
import fs from "node:fs";
import { Client } from "pg";

function parseArgs(argv) {
  const out = { execute: false, file: "backups/_prisma_migrations.before-baseline-reset.json", url: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") out.execute = true;
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--help" || a === "-h") { out.help = true; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage:");
  console.log("  node restore-prisma-migrations.mjs              dry-run (default)");
  console.log("  node restore-prisma-migrations.mjs --execute    actually restore");
  console.log("  Optional: --file <path>  --url <database-url>");
  process.exit(0);
}

const url = args.url || process.env.DATABASE_URL;
if (!url) {
  console.error("ERROR: no DATABASE_URL (.env or --url required)");
  process.exit(2);
}

if (!fs.existsSync(args.file)) {
  console.error(`ERROR: backup file not found: ${args.file}`);
  process.exit(2);
}

const backup = JSON.parse(fs.readFileSync(args.file, "utf-8"));
if (backup.table !== "_prisma_migrations") {
  console.error(`ERROR: backup file is for table "${backup.table}", not _prisma_migrations`);
  process.exit(2);
}
if (!Array.isArray(backup.columns) || !Array.isArray(backup.rows)) {
  console.error("ERROR: backup file malformed (missing columns or rows arrays)");
  process.exit(2);
}

console.log(`Backup file:   ${args.file}`);
console.log(`Captured at:   ${backup.capturedAt}`);
console.log(`Columns:       ${backup.columns.join(", ")}`);
console.log(`Rows to insert: ${backup.rows.length}`);
console.log(`Mode:          ${args.execute ? "EXECUTE (will write to DB)" : "DRY-RUN (no writes)"}`);
console.log(`Target host:   ${new URL(url).host}`);
console.log();

// Columns where the value should be cast to timestamptz on insert.
// Pure data columns (id, checksum, name, logs) stay as plain text/null.
const TIMESTAMPTZ_COLS = new Set(["finished_at", "started_at", "rolled_back_at"]);
const placeholders = backup.columns.map((c, i) =>
  TIMESTAMPTZ_COLS.has(c) ? `$${i + 1}::timestamptz` : `$${i + 1}`,
).join(", ");
const colList = backup.columns.map((c) => `"${c}"`).join(", ");
const sql = `INSERT INTO "_prisma_migrations" (${colList}) VALUES (${placeholders})`;

console.log("Will run, inside one transaction:");
console.log(`  DELETE FROM "_prisma_migrations";`);
console.log(`  ${sql}`);
console.log(`  (${backup.rows.length} row(s) with their backed-up values)`);
console.log();

for (const row of backup.rows) {
  console.log("Row to restore:");
  for (const c of backup.columns) {
    console.log(`  ${c.padEnd(22)} ${row[c] === null ? "NULL" : JSON.stringify(row[c])}`);
  }
}
console.log();

const c = new Client({ connectionString: url });
await c.connect();

if (!args.execute) {
  // Verify the DB is reachable + tell user what they'd see after restore.
  const before = await c.query(`SELECT COUNT(*)::int AS n FROM "_prisma_migrations"`);
  console.log(`Current rows in _prisma_migrations: ${before.rows[0].n}`);
  console.log(`After --execute restore, table will have: ${backup.rows.length} row(s)`);
  console.log();
  console.log("DRY-RUN complete. No changes made. Pass --execute to actually restore.");
  await c.end();
  process.exit(0);
}

// Execute mode — atomic transaction
try {
  await c.query("BEGIN");
  await c.query(`DELETE FROM "_prisma_migrations"`);
  for (const row of backup.rows) {
    const values = backup.columns.map((col) => row[col]);
    await c.query(sql, values);
  }
  const after = await c.query(`SELECT * FROM "_prisma_migrations"`);
  console.log("After INSERTs (still inside transaction):");
  console.log(`  rows: ${after.rowCount}`);
  for (const r of after.rows) {
    console.log(`  - id=${r.id} migration_name=${r.migration_name} checksum=${r.checksum.slice(0, 12)}...`);
  }
  await c.query("COMMIT");
  console.log();
  console.log("RESTORED. Transaction committed.");
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error("ERROR during restore — transaction ROLLED BACK:");
  console.error(e.message);
  process.exit(1);
} finally {
  await c.end();
}
