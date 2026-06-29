#!/usr/bin/env node
// One-shot restore script for the DR drill.
// Reads backups/dump.sql, applies it to a scratch DB on local Postgres.
// No psql/Docker needed — uses node-postgres + pg-copy-streams.

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(import.meta.dirname, "..");
const DUMP_PATH = path.join(ROOT, "backups", "dump.sql");
const HOST = "localhost";
const PORT = 51214;
const USER = "postgres";
const PASS = "postgres";
const TARGET_DB = process.env.RESTORE_DB || "garageos_restore";

const adminUrl = `postgres://${USER}:${PASS}@${HOST}:${PORT}/template1?sslmode=disable`;
const targetUrl = `postgres://${USER}:${PASS}@${HOST}:${PORT}/${TARGET_DB}?sslmode=disable`;

function log(msg) {
  process.stdout.write(`[restore] ${msg}\n`);
}

// Split a pg_dump SQL block into individual statements. pg_dump uses
// `;` at end of line for terminators and doesn't embed `;` inside the
// strings/identifiers we see in --schema=public schema/constraint output.
function splitStatements(sql) {
  const out = [];
  let buf = "";
  let inStr = false;
  let inDollar = false;
  let dollarTag = "";
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const nx = sql[i + 1];
    buf += c;
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inDollar) {
      if (c === "$" && sql.startsWith(dollarTag, i)) {
        inDollar = false;
        buf += dollarTag.slice(1);
        i += dollarTag.length - 1;
      }
      continue;
    }
    if (inStr) {
      if (c === "'" && nx === "'") { buf += "'"; i++; continue; }
      if (c === "'") inStr = false;
      continue;
    }
    if (c === "-" && nx === "-") { inLineComment = true; continue; }
    if (c === "'") { inStr = true; continue; }
    if (c === "$") {
      const m = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (m) {
        inDollar = true;
        dollarTag = m[0];
        buf += dollarTag.slice(1);
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (c === ";") {
      out.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// pg_dump text-format COPY data: tab-separated, NULL is \N, escape sequences
// for backslash/newline/etc. Decodes one row into an array of strings/null.
function parseCopyRow(row) {
  return row.split("\t").map((v) => {
    if (v === "\\N") return null;
    let out = "";
    for (let i = 0; i < v.length; i++) {
      if (v[i] === "\\" && i + 1 < v.length) {
        const nx = v[i + 1];
        if (nx === "n") { out += "\n"; i++; continue; }
        if (nx === "r") { out += "\r"; i++; continue; }
        if (nx === "t") { out += "\t"; i++; continue; }
        if (nx === "b") { out += "\b"; i++; continue; }
        if (nx === "f") { out += "\f"; i++; continue; }
        if (nx === "v") { out += "\v"; i++; continue; }
        if (nx === "\\") { out += "\\"; i++; continue; }
      }
      out += v[i];
    }
    return out;
  });
}

function parseDump(text) {
  const lines = text.split("\n");
  const chunks = [];
  let buf = [];
  let copy = null;

  const flushSql = () => {
    const sql = buf.join("\n").trim();
    if (sql) chunks.push({ type: "sql", text: sql });
    buf = [];
  };

  for (const line of lines) {
    if (copy) {
      if (line === "\\.") {
        chunks.push({ type: "copy", header: copy.header, data: copy.data });
        copy = null;
      } else {
        copy.data.push(line);
      }
      continue;
    }
    if (line.startsWith("\\restrict") || line.startsWith("\\unrestrict")) continue;
    const m = line.match(/^COPY\s+(.+?)\s+FROM\s+stdin;?\s*$/i);
    if (m) {
      flushSql();
      copy = { header: line, data: [] };
      continue;
    }
    buf.push(line);
  }
  flushSql();
  return chunks;
}

async function recreateTargetDb() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  log(`dropping ${TARGET_DB} if exists`);
  // can't drop a DB with open connections, but on a fresh start there are none
  await admin.query(`DROP DATABASE IF EXISTS "${TARGET_DB}"`);
  log(`creating ${TARGET_DB}`);
  await admin.query(`CREATE DATABASE "${TARGET_DB}"`);
  await admin.end();
}

async function applyDump() {
  const dump = fs.readFileSync(DUMP_PATH, "utf8");
  log(`dump size: ${dump.length} bytes`);
  const chunks = parseDump(dump);
  const copyCount = chunks.filter((c) => c.type === "copy").length;
  const sqlCount = chunks.length - copyCount;
  log(`parsed: ${sqlCount} SQL chunks, ${copyCount} COPY blocks`);

  const client = new pg.Client({ connectionString: targetUrl });
  await client.connect();

  let idx = 0;
  for (const chunk of chunks) {
    idx++;
    if (chunk.type === "sql") {
      const statements = splitStatements(chunk.text);
      let sIdx = 0;
      try {
        for (const stmt of statements) {
          sIdx++;
          const trimmed = stmt.trim();
          if (!trimmed) continue;
          await client.query(trimmed);
        }
        log(`  sql  #${idx}: ${statements.length} statements`);
      } catch (e) {
        const failing = statements[sIdx - 1] ?? "(none)";
        process.stderr.write(
          `\n[restore] FAIL on chunk #${idx} (sql) statement ${sIdx}: ${e.message}\n` +
            `--- statement ---\n${failing.slice(0, 600)}\n--- ---\n`
        );
        throw e;
      }
    } else {
      const m = chunk.header.match(/^COPY\s+(.+?)\s*\(([^)]+)\)\s+FROM\s+stdin/i);
      if (!m) {
        process.stderr.write(`\n[restore] bad COPY header on chunk #${idx}: ${chunk.header}\n`);
        throw new Error("bad COPY header");
      }
      const target = m[1];
      const cols = m[2];
      const colCount = cols.split(",").length;
      const placeholders = Array.from({ length: colCount }, (_, i) => `$${i + 1}`).join(", ");
      const insertSql = `INSERT INTO ${target} (${cols}) VALUES (${placeholders})`;
      let rowIdx = 0;
      try {
        for (const raw of chunk.data) {
          if (raw === "") continue;
          rowIdx++;
          const values = parseCopyRow(raw);
          if (values.length !== colCount) {
            throw new Error(`row ${rowIdx} has ${values.length} cols, expected ${colCount}`);
          }
          await client.query(insertSql, values);
        }
        log(`  copy #${idx}: ${target} (${rowIdx} rows)`);
      } catch (e) {
        process.stderr.write(
          `\n[restore] FAIL on chunk #${idx} (copy→insert), row ${rowIdx}: ${e.message}\n` +
            `--- header ---\n${chunk.header}\n` +
            `--- failing row ---\n${chunk.data[rowIdx - 1] ?? "(none)"}\n--- ---\n`
        );
        throw e;
      }
    }
  }

  await client.end();
  log(`applied ${sqlCount} SQL chunks + ${copyCount} COPY blocks`);
}

async function verifyCounts() {
  const client = new pg.Client({ connectionString: targetUrl });
  await client.connect();
  const tables = [
    "Garage",
    "User",
    "Customer",
    "Vehicle",
    "JobCard",
    "Estimate",
    "Invoice",
    "LedgerEntry",
    "Booking",
    "AiEvent",
  ];
  log("--- row counts ---");
  for (const t of tables) {
    try {
      const r = await client.query(`SELECT count(*)::int AS n FROM "public"."${t}"`);
      log(`  ${t.padEnd(14)} ${r.rows[0].n}`);
    } catch (e) {
      log(`  ${t.padEnd(14)} <missing: ${e.message}>`);
    }
  }
  try {
    const r = await client.query(
      `SELECT COALESCE(SUM("amount")::text,'0') AS total FROM "public"."LedgerEntry"`
    );
    log(`  LedgerEntry sum amount: ${r.rows[0].total}`);
  } catch {}
  await client.end();
}

(async () => {
  if (!fs.existsSync(DUMP_PATH)) {
    process.stderr.write(`dump.sql not found at ${DUMP_PATH}\n`);
    process.exit(1);
  }
  await recreateTargetDb();
  await applyDump();
  await verifyCounts();
  log(`done. target db: ${TARGET_DB} @ localhost:${PORT}`);
})().catch((e) => {
  process.stderr.write(`\n[restore] ERROR: ${e?.message ?? e}\n`);
  process.stderr.write(`stack: ${e?.stack ?? "(no stack)"}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (r) => {
  process.stderr.write(`\n[restore] UNHANDLED REJECTION: ${r?.message ?? r}\n`);
  process.stderr.write(`stack: ${r?.stack ?? "(no stack)"}\n`);
  process.exit(1);
});
