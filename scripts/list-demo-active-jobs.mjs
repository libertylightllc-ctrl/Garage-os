// READ-ONLY. Lists every non-terminal JobCard on the Demo Garage
// so we can see exactly what would be cancelled before running a
// mutation. No writes, no risk.
//
//   node scripts/list-demo-active-jobs.mjs

import "./lib/target-local.mjs";
import { Client } from "pg";

const NON_TERMINAL = [
  "ARRIVED",
  "INSPECTION",
  "ESTIMATE",
  "APPROVED",
  "REPAIR",
  "ON_HOLD",
  "EXTRA_WORK_AWAITING_APPROVAL",
  "TECH_COMPLETE",
];

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const dbHost = new URL(process.env.DATABASE_URL).host;
  console.log(`\nConnected to: ${dbHost}\n`);

  const g = await client.query(
    `SELECT id, name, "createdAt" FROM "Garage" WHERE name ILIKE '%demo%' ORDER BY "createdAt"`,
  );
  if (g.rows.length === 0) {
    console.log("No garage matched name ILIKE '%demo%' — aborting.");
    process.exit(1);
  }
  console.log(`Found ${g.rows.length} demo garage(s):`);
  for (const row of g.rows) {
    console.log(`  ${row.id}  ${row.name}  (${row.createdAt.toISOString().slice(0, 10)})`);
  }

  for (const garage of g.rows) {
    console.log(`\n=== ${garage.name} (${garage.id}) ===`);

    const jobs = await client.query(
      `SELECT
         jc.id,
         jc.status,
         jc."createdAt",
         jc."updatedAt",
         v.make,
         v.model,
         v.plate
       FROM "JobCard" jc
       JOIN "Vehicle" v ON v.id = jc."vehicleId"
       WHERE jc."garageId" = $1
         AND jc.status = ANY($2)
       ORDER BY jc."updatedAt" DESC`,
      [garage.id, NON_TERMINAL],
    );

    console.log(`  ${jobs.rows.length} non-terminal job(s):`);
    for (const j of jobs.rows) {
      const label = `${j.make ?? "?"} ${j.model ?? "?"} · ${j.plate ?? "?"}`;
      console.log(
        `  ${j.id}  ${j.status.padEnd(30)}  ${label.padEnd(35)}  updated=${j.updatedAt.toISOString().slice(0, 10)}`,
      );
    }

    // Also count terminal (already done / cancelled) for reference
    const term = await client.query(
      `SELECT status, COUNT(*)::int AS n FROM "JobCard"
       WHERE "garageId" = $1 AND status NOT IN (${NON_TERMINAL.map((_, i) => `$${i + 2}`).join(",")})
       GROUP BY status`,
      [garage.id, ...NON_TERMINAL],
    );
    if (term.rows.length) {
      console.log(`  Terminal (not touched):`);
      for (const t of term.rows) {
        console.log(`    ${t.status.padEnd(30)} ${t.n}`);
      }
    }
  }
} finally {
  await client.end();
}
