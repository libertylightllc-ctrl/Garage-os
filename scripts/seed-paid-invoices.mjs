// LOCAL DEV ONLY. Seeds 50 fully-paid demo invoices so we can exercise
// pagination in the browser. Uses an existing demo customer + vehicle.
//
//   node scripts/seed-paid-invoices.mjs
//
// Refuses to run against a non-localhost DATABASE_URL.

import "dotenv/config";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !new URL(dbUrl).host.startsWith("localhost")) {
  console.error("Refusing — DATABASE_URL host is not localhost.");
  process.exit(1);
}

const N = 50;

const c = new Client({ connectionString: dbUrl });
await c.connect();
try {
  const g = await c.query(
    `SELECT id FROM "Garage" WHERE name ILIKE '%demo%' LIMIT 1`,
  );
  if (!g.rows.length) throw new Error("No demo garage.");
  const garageId = g.rows[0].id;

  const v = await c.query(
    `SELECT id FROM "Vehicle" WHERE "customerId" IN (
       SELECT id FROM "Customer" WHERE "garageId" = $1
     ) LIMIT 1`,
    [garageId],
  );
  if (!v.rows.length) throw new Error("No demo vehicle.");
  const vehicleId = v.rows[0].id;

  // Base number so we don't collide with the per-garage gapless sequence.
  const seqRow = await c.query(
    `SELECT COALESCE(MAX(number), 0) + 1 AS next FROM "Invoice" WHERE "garageId" = $1`,
    [garageId],
  );
  let n = Number(seqRow.rows[0].next);

  console.log(`Seeding ${N} paid invoices starting at number=${n}...`);
  for (let i = 0; i < N; i++) {
    const jobId = `pgn-job-${randomUUID().slice(0, 8)}`;
    const invId = `pgn-inv-${randomUUID().slice(0, 8)}`;
    const paidAt = new Date(Date.now() - i * 3_600_000); // stagger by hours

    await c.query(
      `INSERT INTO "JobCard" (id, "garageId", "vehicleId", status, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'DELIVERED', NOW(), NOW())`,
      [jobId, garageId, vehicleId],
    );
    await c.query(
      `INSERT INTO "Invoice" (id, "garageId", "jobCardId", number, "issuedAt", "dueDate", subtotal, "vatAmount", total, status, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $5, 100, 5, 105, 'PAID', $5, $5)`,
      [invId, garageId, jobId, n, paidAt],
    );
    await c.query(
      `INSERT INTO "Payment" (id, "invoiceId", amount, method, "paidAt", "createdAt", "updatedAt")
       VALUES ($1, $2, 105, 'CASH', $3, $3, $3)`,
      [`pgn-pay-${randomUUID().slice(0, 8)}`, invId, paidAt],
    );
    n++;
  }
  console.log("Done.");
} finally {
  await c.end();
}
