// Operator-only — delete a whole garage tenant (Garage row + every
// row that hangs off it) safely and transactionally.
//
//   node scripts/delete-garage.mjs --garageId <cuid>             # dry-run (default)
//   node scripts/delete-garage.mjs --garageId <cuid> --execute   # actually delete
//
// Reads DATABASE_URL from .env. Walks every table that has rows
// scoped (directly or indirectly) to a garage, counts rows, prints a
// summary. In --execute mode, runs every DELETE in ONE transaction
// in FK dependency order so a failure mid-way rolls everything back
// — no orphan rows can ever leak through a partial run.
//
// Refuses to do anything if the Garage row doesn't exist. Prints the
// garage name + createdAt for the operator to sanity-check the right
// row before approving --execute.

import "dotenv/config";
import { Client } from "pg";

function parseArgs(argv) {
  const out = { execute: false, garageId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") out.execute = true;
    else if (a === "--garageId") out.garageId = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.garageId) {
  console.log("Usage:");
  console.log("  node scripts/delete-garage.mjs --garageId <cuid>");
  console.log("  node scripts/delete-garage.mjs --garageId <cuid> --execute");
  process.exit(args.help ? 0 : 2);
}

const gid = args.garageId;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

console.log("=== Target garage ===");
const g = await c.query(
  `SELECT id, name, country, "isPilot", "createdAt" FROM "Garage" WHERE id = $1`,
  [gid],
);
if (g.rowCount === 0) {
  console.error(`ERROR: no Garage row with id ${gid}`);
  await c.end();
  process.exit(2);
}
console.log(`  id:        ${g.rows[0].id}`);
console.log(`  name:      ${g.rows[0].name}`);
console.log(`  country:   ${g.rows[0].country}`);
console.log(`  isPilot:   ${g.rows[0].isPilot}`);
console.log(`  createdAt: ${g.rows[0].createdAt.toISOString()}`);
console.log(`  mode:      ${args.execute ? "EXECUTE (will delete)" : "DRY-RUN (no writes)"}`);
console.log(`  DB host:   ${new URL(process.env.DATABASE_URL).host}`);
console.log();

// Each entry: (table, COUNT-SQL, DELETE-SQL). Order in this array
// IS the dependency-safe delete order. Children of children (depth >=
// 2) MUST come before their parents.
const STEPS = [
  // -- depth 3+ (children of children) --
  ["Payment", `SELECT COUNT(*)::int n FROM "Payment" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "garageId" = $1)`,
              `DELETE FROM "Payment" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "garageId" = $1)`],
  ["InvoiceLine", `SELECT COUNT(*)::int n FROM "InvoiceLine" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "garageId" = $1)`,
                  `DELETE FROM "InvoiceLine" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "garageId" = $1)`],
  ["EstimateLine", `SELECT COUNT(*)::int n FROM "EstimateLine" WHERE "estimateId" IN (SELECT id FROM "Estimate" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1))`,
                   `DELETE FROM "EstimateLine" WHERE "estimateId" IN (SELECT id FROM "Estimate" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1))`],
  ["JobStep", `SELECT COUNT(*)::int n FROM "JobStep" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`,
              `DELETE FROM "JobStep" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`],
  ["JobFinding", `SELECT COUNT(*)::int n FROM "JobFinding" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`,
                 `DELETE FROM "JobFinding" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`],
  ["JobPart", `SELECT COUNT(*)::int n FROM "JobPart" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`,
              `DELETE FROM "JobPart" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`],
  ["JobHelper", `SELECT COUNT(*)::int n FROM "JobHelper" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`,
                `DELETE FROM "JobHelper" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`],
  ["PartMovement", `SELECT COUNT(*)::int n FROM "PartMovement" WHERE "partId" IN (SELECT id FROM "Part" WHERE "garageId" = $1)`,
                   `DELETE FROM "PartMovement" WHERE "partId" IN (SELECT id FROM "Part" WHERE "garageId" = $1)`],
  ["WhatsAppMessage", `SELECT COUNT(*)::int n FROM "WhatsAppMessage" WHERE "threadId" IN (SELECT id FROM "WhatsAppThread" WHERE "garageId" = $1)`,
                      `DELETE FROM "WhatsAppMessage" WHERE "threadId" IN (SELECT id FROM "WhatsAppThread" WHERE "garageId" = $1)`],
  // -- depth 2 (children of garage's direct children) --
  ["Estimate", `SELECT COUNT(*)::int n FROM "Estimate" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`,
               `DELETE FROM "Estimate" WHERE "jobCardId" IN (SELECT id FROM "JobCard" WHERE "garageId" = $1)`],
  // Vehicle moved DOWN, after JobCard — JobCard.vehicleId references
  // Vehicle, so JobCards must be gone before any Vehicle delete.
  // (Counted here, deleted further down.)
  // -- depth 1 (direct garageId scope) --
  ["LedgerEntry", `SELECT COUNT(*)::int n FROM "LedgerEntry" WHERE "garageId" = $1`,
                  `DELETE FROM "LedgerEntry" WHERE "garageId" = $1`],
  ["Reminder", `SELECT COUNT(*)::int n FROM "Reminder" WHERE "garageId" = $1`,
               `DELETE FROM "Reminder" WHERE "garageId" = $1`],
  ["PartRequest", `SELECT COUNT(*)::int n FROM "PartRequest" WHERE "garageId" = $1`,
                  `DELETE FROM "PartRequest" WHERE "garageId" = $1`],
  ["AdvancePayment", `SELECT COUNT(*)::int n FROM "AdvancePayment" WHERE "garageId" = $1`,
                     `DELETE FROM "AdvancePayment" WHERE "garageId" = $1`],
  ["WhatsAppThread", `SELECT COUNT(*)::int n FROM "WhatsAppThread" WHERE "garageId" = $1`,
                     `DELETE FROM "WhatsAppThread" WHERE "garageId" = $1`],
  ["WhatsAppAccount", `SELECT COUNT(*)::int n FROM "WhatsAppAccount" WHERE "garageId" = $1`,
                      `DELETE FROM "WhatsAppAccount" WHERE "garageId" = $1`],
  ["AiEvent", `SELECT COUNT(*)::int n FROM "AiEvent" WHERE "garageId" = $1`,
              `DELETE FROM "AiEvent" WHERE "garageId" = $1`],
  ["Booking", `SELECT COUNT(*)::int n FROM "Booking" WHERE "garageId" = $1`,
              `DELETE FROM "Booking" WHERE "garageId" = $1`],
  ["Invoice", `SELECT COUNT(*)::int n FROM "Invoice" WHERE "garageId" = $1`,
              `DELETE FROM "Invoice" WHERE "garageId" = $1`],
  ["JobCard", `SELECT COUNT(*)::int n FROM "JobCard" WHERE "garageId" = $1`,
              `DELETE FROM "JobCard" WHERE "garageId" = $1`],
  // Vehicle deletion happens HERE — after JobCard rows are gone.
  ["Vehicle", `SELECT COUNT(*)::int n FROM "Vehicle" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "garageId" = $1)`,
              `DELETE FROM "Vehicle" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "garageId" = $1)`],
  ["Customer", `SELECT COUNT(*)::int n FROM "Customer" WHERE "garageId" = $1`,
               `DELETE FROM "Customer" WHERE "garageId" = $1`],
  ["Part", `SELECT COUNT(*)::int n FROM "Part" WHERE "garageId" = $1`,
           `DELETE FROM "Part" WHERE "garageId" = $1`],
  ["Bay", `SELECT COUNT(*)::int n FROM "Bay" WHERE "garageId" = $1`,
          `DELETE FROM "Bay" WHERE "garageId" = $1`],
  // NB: BillingEvent has no garageId (it's a global Stripe-event log,
  // intentionally not scoped to a tenant) so it's not part of this walk.
  ["Subscription", `SELECT COUNT(*)::int n FROM "Subscription" WHERE "garageId" = $1`,
                   `DELETE FROM "Subscription" WHERE "garageId" = $1`],
  ["User", `SELECT COUNT(*)::int n FROM "User" WHERE "garageId" = $1`,
           `DELETE FROM "User" WHERE "garageId" = $1`],
  // -- the garage row itself --
  ["Garage", `SELECT COUNT(*)::int n FROM "Garage" WHERE id = $1`,
             `DELETE FROM "Garage" WHERE id = $1`],
];

console.log("=== Row counts by table (scoped to this garage) ===");
const counts = {};
for (const [name, countSql] of STEPS) {
  const r = await c.query(countSql, [gid]);
  counts[name] = r.rows[0].n;
  if (r.rows[0].n > 0) {
    console.log(`  ${name.padEnd(18)} ${r.rows[0].n}`);
  }
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`  ---`);
console.log(`  Total rows attached: ${total}`);
console.log();

if (!args.execute) {
  console.log("DRY-RUN complete. No changes made.");
  console.log("Pass --execute to actually delete this garage and all rows above.");
  await c.end();
  process.exit(0);
}

console.log("=== Executing deletes in one transaction ===");
try {
  await c.query("BEGIN");
  for (const [name, , deleteSql] of STEPS) {
    const r = await c.query(deleteSql, [gid]);
    if (r.rowCount > 0) {
      console.log(`  DELETE ${name.padEnd(18)} ${r.rowCount} rows`);
    }
  }
  await c.query("COMMIT");
  console.log();
  console.log("DELETED. Transaction committed.");
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error("ERROR — transaction ROLLED BACK:");
  console.error(e.message);
  process.exit(1);
} finally {
  await c.end();
}
