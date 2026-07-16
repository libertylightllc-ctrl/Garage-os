// LOCAL DEV ONLY. Picks the first demo-garage JobCard and flips its
// status to INVOICED so we can drive the delivery form in the browser.
//
//   node scripts/seed-invoiced-job.mjs
//
// Reads DATABASE_URL from .env.local (via prisma.config shim in
// process.env). Aborts if the host is not localhost.

import "dotenv/config";
import { Client } from "pg";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !new URL(dbUrl).host.startsWith("localhost")) {
  console.error("Refusing to run — DATABASE_URL host is not localhost.");
  process.exit(1);
}

const c = new Client({ connectionString: dbUrl });
await c.connect();
try {
  const g = await c.query(
    `SELECT id, name FROM "Garage" WHERE name ILIKE '%demo%' LIMIT 1`,
  );
  if (!g.rows.length) throw new Error("No demo garage found.");
  const garage = g.rows[0];

  const j = await c.query(
    `SELECT jc.id, jc.status, v.make, v.model, v.plate
       FROM "JobCard" jc
       JOIN "Vehicle" v ON v.id = jc."vehicleId"
      WHERE jc."garageId" = $1
        AND jc.status NOT IN ('DELIVERED','CANCELLED')
      ORDER BY jc."createdAt" ASC
      LIMIT 1`,
    [garage.id],
  );
  if (!j.rows.length) throw new Error("No active demo job to flip.");
  const job = j.rows[0];
  console.log(
    `Flipping ${job.make} ${job.model} ${job.plate} (${job.id}) : ${job.status} -> INVOICED`,
  );

  await c.query(
    `UPDATE "JobCard" SET status = 'INVOICED', "updatedAt" = NOW() WHERE id = $1`,
    [job.id],
  );

  console.log(`Done. Open: http://localhost:3000/advisor/jobs/${job.id}`);
} finally {
  await c.end();
}
