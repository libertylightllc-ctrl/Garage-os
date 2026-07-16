// LOCAL DEV ONLY. Seeds double-entry balanced LedgerEntry rows into the
// demo garage so the owner ledger balance table shows nonzero figures
// across ALL FIVE accounts. Used for the ledger-refactor BEFORE/AFTER
// parity screenshot — zeros vs zeros doesn't prove anything.
//
// Runs the same debit/credit pairs that billing.ts would produce for a
// realistic mix: invoice issuance, cash payment, advance received,
// advance migration. Every pair balances (Σ debit == Σ credit) so the
// trial-balance banner stays green.
//
//   node scripts/seed-ledger-balances.mjs [--wipe]
//
// --wipe first deletes any existing LedgerEntry rows on the demo garage
// (deterministic reruns).

import "dotenv/config";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !new URL(dbUrl).host.startsWith("localhost")) {
  console.error("Refusing — DATABASE_URL host is not localhost.");
  process.exit(1);
}

const wipe = process.argv.includes("--wipe");

const c = new Client({ connectionString: dbUrl });
await c.connect();
try {
  const g = await c.query(
    `SELECT id FROM "Garage" WHERE name ILIKE '%demo%' LIMIT 1`,
  );
  if (!g.rows.length) throw new Error("No demo garage.");
  const garageId = g.rows[0].id;

  if (wipe) {
    const r = await c.query(
      `DELETE FROM "LedgerEntry" WHERE "garageId" = $1`,
      [garageId],
    );
    console.log(`Wiped ${r.rowCount} existing LedgerEntry rows.`);
  }

  // Double-entry sets. Each SET must have equal debits + credits.
  // Amounts are AED-ish. Dates staggered inside July 2026 so the
  // date-range filter picks them all up.
  //
  //   AR    → Accounts Receivable  (debit-normal asset)
  //   CASH  → Cash/Bank            (debit-normal asset)
  //   DEPS  → Customer Deposits    (credit-normal liability)
  //   VAT   → VAT Payable          (credit-normal liability)
  //   SALES → Sales Revenue        (credit-normal revenue)
  const AR = "Accounts Receivable";
  const CASH = "Cash/Bank";
  const DEPS = "Customer Deposits";
  const VAT = "VAT Payable";
  const SALES = "Sales Revenue";

  const day = (n) => new Date(`2026-07-${String(n).padStart(2, "0")}T10:00:00Z`);

  const sets = [
    // Invoice #1 issued: AR 2100, Sales 2000, VAT 100
    { at: day(2), entries: [[AR, 2100, 0], [SALES, 0, 2000], [VAT, 0, 100]] },
    // Customer pays invoice #1 in cash: CASH 2100, AR -2100
    { at: day(3), entries: [[CASH, 2100, 0], [AR, 0, 2100]] },
    // Invoice #2 issued: AR 4200, Sales 4000, VAT 200
    { at: day(5), entries: [[AR, 4200, 0], [SALES, 0, 4000], [VAT, 0, 200]] },
    // Advance received against a job: CASH 1500, DEPS -1500
    { at: day(6), entries: [[CASH, 1500, 0], [DEPS, 0, 1500]] },
    // Invoice #3 issued: AR 3150, Sales 3000, VAT 150
    { at: day(8), entries: [[AR, 3150, 0], [SALES, 0, 3000], [VAT, 0, 150]] },
    // Partial payment on invoice #2 (half): CASH 2100, AR -2100
    { at: day(10), entries: [[CASH, 2100, 0], [AR, 0, 2100]] },
    // Migrate advance to a payment on invoice #3: DEPS +1500 (reversed liability), AR -1500
    { at: day(12), entries: [[DEPS, 1500, 0], [AR, 0, 1500]] },
    // Invoice #4 issued: AR 5250, Sales 5000, VAT 250
    { at: day(14), entries: [[AR, 5250, 0], [SALES, 0, 5000], [VAT, 0, 250]] },
    // Small cash sale (no AR): CASH 525, Sales 500, VAT 25
    { at: day(15), entries: [[CASH, 525, 0], [SALES, 0, 500], [VAT, 0, 25]] },
  ];

  // Sanity check locally before writing.
  let totalD = 0, totalC = 0;
  for (const s of sets) {
    let d = 0, c2 = 0;
    for (const [, deb, cred] of s.entries) { d += deb; c2 += cred; }
    if (Math.round((d - c2) * 100) !== 0) {
      throw new Error(`Set at ${s.at} is unbalanced: D=${d} C=${c2}`);
    }
    totalD += d; totalC += c2;
  }
  console.log(`Batch balanced: Debit ${totalD} = Credit ${totalC}`);

  for (const s of sets) {
    for (const [account, debit, credit] of s.entries) {
      await c.query(
        `INSERT INTO "LedgerEntry" (id, "garageId", account, debit, credit, "sourceType", "sourceId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'SEED', $6, $7, $7)`,
        [`led-${randomUUID().slice(0, 8)}`, garageId, account, debit, credit, `seed-${randomUUID().slice(0, 6)}`, s.at],
      );
    }
  }
  console.log(`Inserted ${sets.reduce((n, s) => n + s.entries.length, 0)} LedgerEntry rows.`);
} finally {
  await c.end();
}
