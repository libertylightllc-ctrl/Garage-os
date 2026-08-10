// Step 3 — back up production's _prisma_migrations table to a
// restorable .sql file BEFORE we touch it in Step 4.
//
// Pure read on production. Writes INSERT statements that recreate
// every existing row, plus a one-line rollback header so a future-you
// can restore from this file in one psql session.
//
//   node backup-prisma-migrations.mjs
//
// Output: backups/_prisma_migrations.before-baseline-reset.<timestamp>.sql

import "./lib/target-prod.mjs";
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";

function quoteLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/'/g, "''")}'`;
}

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const cols = await c.query(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
  ORDER BY ordinal_position
`);
const colNames = cols.rows.map((r) => r.column_name);
const data = await c.query(
  `SELECT ${colNames.map((c) => `"${c}"`).join(", ")} FROM "_prisma_migrations" ORDER BY started_at`,
);
await c.end();

const ts = "before-baseline-reset";
// Date.now() unavailable in workflow scripts; use a fixed token; AR
// can rename the file after the fact if needed.
const outPath = path.join("backups", `_prisma_migrations.${ts}.sql`);

const lines = [
  `-- Backup of public._prisma_migrations from production`,
  `-- Captured BEFORE Step 4 of the migration baseline reset.`,
  `-- Restore:  psql "$DATABASE_URL" -f ${outPath}`,
  `--`,
  `-- Columns: ${colNames.join(", ")}`,
  `-- Row count: ${data.rowCount}`,
  ``,
  `BEGIN;`,
  `-- Wipe whatever's in the table now (rollback puts the rows below back exactly as they were):`,
  `DELETE FROM "_prisma_migrations";`,
  ``,
];
for (const row of data.rows) {
  const values = colNames.map((c) => quoteLiteral(row[c])).join(", ");
  lines.push(`INSERT INTO "_prisma_migrations" (${colNames.map((c) => `"${c}"`).join(", ")}) VALUES (${values});`);
}
lines.push("");
lines.push("COMMIT;");
lines.push("");

fs.writeFileSync(outPath, lines.join("\n"), "utf-8");

// JSON sidecar — what restore-prisma-migrations.mjs reads. Pure data,
// no SQL parsing, no psql dependency. The .sql file is for humans /
// emergency manual restore via the Supabase SQL editor.
const jsonPath = outPath.replace(/\.sql$/, ".json");
const jsonPayload = {
  table: "_prisma_migrations",
  capturedAt: "before-baseline-reset",
  columns: colNames,
  rows: data.rows.map((row) => {
    // Serialize Date instances to ISO strings so JSON round-trips
    // losslessly — restore re-casts to timestamptz on the way back in.
    const out = {};
    for (const c of colNames) {
      const v = row[c];
      out[c] = v instanceof Date ? v.toISOString() : v;
    }
    return out;
  }),
};
fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), "utf-8");

console.log("Wrote:", outPath, "(human-readable .sql)");
console.log("Wrote:", jsonPath, "(machine-readable .json for restore)");
console.log("Rows backed up:", data.rowCount);
console.log("Columns:", colNames.join(", "));
console.log();
console.log("--- .sql preview ---");
console.log(lines.slice(0, 15).join("\n"));
console.log("...");
console.log(lines.slice(-3).join("\n"));
