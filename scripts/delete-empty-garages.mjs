// Operator-only — delete FOUR specific empty garages by name.
//
//   node scripts/delete-empty-garages.mjs             # dry-run (default)
//   node scripts/delete-empty-garages.mjs --commit    # actually delete
//
// This script is narrowly scoped to a fixed whitelist of four garage
// NAMES that AR has confirmed are unused. Unlike delete-garage.mjs
// (which deletes any garage by id), this script:
//
//   1. Resolves the four whitelisted names → Garage ids at run time.
//      If ANY name isn't found, or MORE than one row matches a name,
//      it aborts before any writes.
//   2. Verifies each resolved garage is genuinely empty — every
//      per-garage table (JobCard, Customer, Vehicle, Part, etc.) has
//      zero rows, with the sole exception of `User` (staff logins are
//      expected leftover). Non-zero anywhere aborts the whole run.
//   3. On --commit, wraps every delete across all four garages in ONE
//      transaction. Any error rolls the lot back — partial state is
//      impossible.
//   4. The DELETE queries key off the resolved id list only. There is
//      NO code path in this script that can touch a garage whose name
//      isn't in NAME_WHITELIST below.
//
// Dry-run prints the resolved (name → id) map, the per-garage row
// counts, and a verdict per garage (SAFE-TO-DELETE / NOT-EMPTY).

import "./lib/target-prod.mjs";
import { Client } from "pg";

// The four names AR authorised. Comparison is case-sensitive against
// the DB — the DB has these verbatim (visible on the owner-admin
// dashboard). Do NOT loosen this to case-insensitive without an audit;
// the whole safety of the script rests on this list matching exactly
// what AR named.
const NAME_WHITELIST = [
    "Al Quoz Auto Care",
    "Aplus",
    "Power Drive",
    "sandeep garage",
];

function parseArgs(argv) {
    const out = { commit: false, help: false };
    for (const a of argv) {
        if (a === "--commit") out.commit = true;
        else if (a === "--dry-run") out.commit = false;
        else if (a === "--help" || a === "-h") out.help = true;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    console.log("Usage:");
    console.log("  node scripts/delete-empty-garages.mjs");
    console.log("  node scripts/delete-empty-garages.mjs --commit");
    console.log();
    console.log("Deletes the four whitelisted empty garages:");
    for (const n of NAME_WHITELIST) console.log(`  - ${n}`);
    process.exit(0);
}

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

console.log("=== Target ===");
console.log(`  DB host: ${new URL(process.env.DATABASE_URL).host}`);
console.log(`  Mode:    ${args.commit ? "COMMIT (will delete)" : "DRY-RUN (no writes)"}`);
console.log(`  Names:   ${NAME_WHITELIST.length} whitelisted`);
console.log();

// ── Resolve names → ids ──────────────────────────────────────────
// Uses ANY($1) with the whitelist array so the SQL is a single
// round-trip and the result set can never contain a row outside the
// list. Ambiguity check catches the (unlikely but possible) case of
// two garages with the same name.
console.log("=== Resolving names ===");
const resolved = await c.query(
    `SELECT id, name, country, "isPilot", "createdAt"
     FROM "Garage"
     WHERE name = ANY($1::text[])
     ORDER BY name`,
    [NAME_WHITELIST],
);

// One row per whitelisted name — fail if any name is missing OR
// duplicated (same name on two rows would blow up the "we know what
// we're deleting" invariant).
const byName = new Map();
for (const row of resolved.rows) {
    if (byName.has(row.name)) {
        console.error(`ERROR: name "${row.name}" resolves to MULTIPLE Garage rows. Aborting.`);
        await c.end();
        process.exit(2);
    }
    byName.set(row.name, row);
}
const missing = NAME_WHITELIST.filter((n) => !byName.has(n));
if (missing.length > 0) {
    console.error(`ERROR: whitelist names not found in DB:`);
    for (const n of missing) console.error(`  - ${n}`);
    console.error(`Nothing deleted. Check spelling (case-sensitive) against the owner-admin dashboard.`);
    await c.end();
    process.exit(2);
}
for (const name of NAME_WHITELIST) {
    const r = byName.get(name);
    console.log(`  ${name.padEnd(22)} → id=${r.id} (${r.country}, isPilot=${r.isPilot}, created ${r.createdAt.toISOString().slice(0, 10)})`);
}
console.log();

// Frozen list of ids we're allowed to touch. Every SQL statement
// below binds against this array — no code path constructs an id
// from any other source. If NAME_WHITELIST is empty (defensive),
// STEP_QUERIES would run with ANY('{}'::text[]) which matches
// nothing, so a wrongly-emptied whitelist deletes nothing rather
// than everything.
const GARAGE_IDS = NAME_WHITELIST.map((n) => byName.get(n).id);

// ── Row counts per table, per garage ─────────────────────────────
// Same table set as delete-garage.mjs. Sequenced in FK-safe delete
// order for the --commit path. `expectedZero` marks the tables that
// AR's "genuinely empty" invariant requires be zero across every
// whitelisted garage. `User` is deliberately NOT in expectedZero —
// staff logins are the expected leftover on these four.
const STEPS = [
    // -- depth 3+ (children of children) --
    { name: "Payment",         expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Payment" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "garageId" = $1)`, del: `DELETE FROM "Payment" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "garageId" = ANY($1::text[]))` },
    { name: "InvoiceLine",     expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "InvoiceLine" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "garageId" = $1)`, del: `DELETE FROM "InvoiceLine" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "garageId" = ANY($1::text[]))` },
    { name: "EstimateLine",    expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "EstimateLine" WHERE "estimateId" IN (SELECT id FROM "Estimate" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1))`, del: `DELETE FROM "EstimateLine" WHERE "estimateId" IN (SELECT id FROM "Estimate" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = ANY($1::text[])))` },
    { name: "JobStep",         expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "JobStep" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`, del: `DELETE FROM "JobStep" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = ANY($1::text[]))` },
    { name: "JobFinding",      expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "JobFinding" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`, del: `DELETE FROM "JobFinding" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = ANY($1::text[]))` },
    { name: "JobPart",         expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "JobPart" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`, del: `DELETE FROM "JobPart" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = ANY($1::text[]))` },
    { name: "JobHelper",       expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "JobHelper" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`, del: `DELETE FROM "JobHelper" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = ANY($1::text[]))` },
    { name: "PartMovement",    expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "PartMovement" WHERE "partId" IN (SELECT id FROM "Part" WHERE "garageId" = $1)`, del: `DELETE FROM "PartMovement" WHERE "partId" IN (SELECT id FROM "Part" WHERE "garageId" = ANY($1::text[]))` },
    { name: "WhatsAppMessage", expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "WhatsAppMessage" WHERE "threadId" IN (SELECT id FROM "WhatsAppThread" WHERE "garageId" = $1)`, del: `DELETE FROM "WhatsAppMessage" WHERE "threadId" IN (SELECT id FROM "WhatsAppThread" WHERE "garageId" = ANY($1::text[]))` },
    // -- depth 2 --
    { name: "Estimate",        expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Estimate" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`, del: `DELETE FROM "Estimate" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = ANY($1::text[]))` },
    // -- depth 1 --
    { name: "LedgerEntry",     expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "LedgerEntry" WHERE "garageId" = $1`, del: `DELETE FROM "LedgerEntry" WHERE "garageId" = ANY($1::text[])` },
    { name: "Reminder",        expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Reminder" WHERE "garageId" = $1`, del: `DELETE FROM "Reminder" WHERE "garageId" = ANY($1::text[])` },
    { name: "PartRequest",     expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "PartRequest" WHERE "garageId" = $1`, del: `DELETE FROM "PartRequest" WHERE "garageId" = ANY($1::text[])` },
    { name: "AdvancePayment",  expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "AdvancePayment" WHERE "garageId" = $1`, del: `DELETE FROM "AdvancePayment" WHERE "garageId" = ANY($1::text[])` },
    { name: "WhatsAppThread",  expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "WhatsAppThread" WHERE "garageId" = $1`, del: `DELETE FROM "WhatsAppThread" WHERE "garageId" = ANY($1::text[])` },
    { name: "WhatsAppAccount", expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "WhatsAppAccount" WHERE "garageId" = $1`, del: `DELETE FROM "WhatsAppAccount" WHERE "garageId" = ANY($1::text[])` },
    { name: "AiEvent",         expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "AiEvent" WHERE "garageId" = $1`, del: `DELETE FROM "AiEvent" WHERE "garageId" = ANY($1::text[])` },
    { name: "Booking",         expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Booking" WHERE "garageId" = $1`, del: `DELETE FROM "Booking" WHERE "garageId" = ANY($1::text[])` },
    { name: "Invoice",         expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Invoice" WHERE "garageId" = $1`, del: `DELETE FROM "Invoice" WHERE "garageId" = ANY($1::text[])` },
    { name: "JobCard",         expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "JobCard" WHERE "garageId" = $1`, del: `DELETE FROM "JobCard" WHERE "garageId" = ANY($1::text[])` },
    { name: "Vehicle",         expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Vehicle" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "garageId" = $1)`, del: `DELETE FROM "Vehicle" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "garageId" = ANY($1::text[]))` },
    { name: "Customer",        expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Customer" WHERE "garageId" = $1`, del: `DELETE FROM "Customer" WHERE "garageId" = ANY($1::text[])` },
    { name: "Part",            expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Part" WHERE "garageId" = $1`, del: `DELETE FROM "Part" WHERE "garageId" = ANY($1::text[])` },
    { name: "Bay",             expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Bay" WHERE "garageId" = $1`, del: `DELETE FROM "Bay" WHERE "garageId" = ANY($1::text[])` },
    { name: "Subscription",    expectedZero: true,  count: `SELECT COUNT(*)::int n FROM "Subscription" WHERE "garageId" = $1`, del: `DELETE FROM "Subscription" WHERE "garageId" = ANY($1::text[])` },
    // User is NOT expectedZero — staff logins are the expected leftover.
    { name: "User",            expectedZero: false, count: `SELECT COUNT(*)::int n FROM "User" WHERE "garageId" = $1`, del: `DELETE FROM "User" WHERE "garageId" = ANY($1::text[])` },
    // Garage row itself.
    { name: "Garage",          expectedZero: false, count: `SELECT COUNT(*)::int n FROM "Garage" WHERE id = $1`, del: `DELETE FROM "Garage" WHERE id = ANY($1::text[])` },
];

// ── Verify: count each table per garage, report + gate ───────────
console.log("=== Row counts per garage ===");
const perGarageCounts = new Map(); // id → { table → n }
for (const name of NAME_WHITELIST) {
    const row = byName.get(name);
    const counts = {};
    for (const step of STEPS) {
        const r = await c.query(step.count, [row.id]);
        counts[step.name] = r.rows[0].n;
    }
    perGarageCounts.set(row.id, counts);
}

let anyNotEmpty = false;
for (const name of NAME_WHITELIST) {
    const row = byName.get(name);
    const counts = perGarageCounts.get(row.id);
    const nonZero = STEPS.filter((s) => s.expectedZero && counts[s.name] > 0);
    const userCount = counts["User"] ?? 0;
    const verdict = nonZero.length === 0 ? "SAFE-TO-DELETE" : "NOT-EMPTY (refuse)";
    console.log(`  ${name}`);
    console.log(`    id:       ${row.id}`);
    console.log(`    users:    ${userCount}  (staff logins — expected)`);
    if (nonZero.length === 0) {
        console.log(`    verdict:  ${verdict}`);
    } else {
        anyNotEmpty = true;
        console.log(`    verdict:  ${verdict}`);
        console.log(`    unexpected non-zero tables:`);
        for (const s of nonZero) {
            console.log(`      - ${s.name.padEnd(18)} ${counts[s.name]}`);
        }
    }
}
console.log();

if (anyNotEmpty) {
    console.error("ABORT: at least one whitelisted garage has non-zero data rows. Nothing deleted.");
    console.error("(--commit refuses to proceed unless every garage passes the empty check.)");
    await c.end();
    process.exit(1);
}

if (!args.commit) {
    console.log("DRY-RUN complete. All four garages verified SAFE-TO-DELETE.");
    console.log("Re-run with --commit to actually delete.");
    await c.end();
    process.exit(0);
}

// ── Execute ─────────────────────────────────────────────────────
// One transaction across all four garages. Any failure → rollback,
// nothing changes. Every DELETE binds against GARAGE_IDS (or the
// derived subquery from Garage.id IN GARAGE_IDS), so no row outside
// the whitelist can be touched.
console.log("=== Executing deletes in one transaction (all 4 garages) ===");
try {
    await c.query("BEGIN");
    for (const step of STEPS) {
        const r = await c.query(step.del, [GARAGE_IDS]);
        if (r.rowCount > 0) {
            console.log(`  DELETE ${step.name.padEnd(18)} ${r.rowCount} rows`);
        }
    }
    await c.query("COMMIT");
    console.log();
    console.log("DELETED. Transaction committed. Four garages removed.");
} catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("ERROR — transaction ROLLED BACK:");
    console.error(e.message);
    process.exit(1);
} finally {
    await c.end();
}
