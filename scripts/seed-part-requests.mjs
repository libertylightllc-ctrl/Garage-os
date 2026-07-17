// LOCAL DEV ONLY. Seeds ~50 PartRequest rows on the demo garage so
// /advisor/parts pagination + layout can be verified against varied real
// data.
//
//   node scripts/seed-part-requests.mjs [--wipe]
//
// HARD GUARD: refuses to run against anything but a localhost DATABASE_URL.
// The demo garage must exist AND have at least a few JobCards (the seed
// itself won't invent job cards — it grabs random real ones). --wipe first
// deletes all PartRequest rows on the demo garage for deterministic reruns.
//
// Variety by design — pagination + layout bugs only surface against messy
// data:
//   - description: long multi-word, short abbreviations, Arabic script,
//     ALL CAPS, mixed case, with brand & part number
//   - qty: 1, 2, 4, 8, 16, occasional 100 (wholesale case)
//   - partId: some rows tie to a catalog Part, others are pure free-text
//   - requestedById: some rows have a tech attribution, others don't
//   - note: some rows have a supplier ETA note, others don't; a few long
//   - status: heavy spread across REQUESTED / ORDERED / ARRIVED (the OPEN
//     bucket the page shows), plus a handful of FULFILLED + CANCELLED to
//     prove those TERMINAL statuses stay out of the list (regression
//     coverage for the drift we just closed with the exhaustive helper).
//   - createdAt: spread across the last 30 days so orderBy: asc doesn't
//     just print rows in insertion order

import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

// Seed scripts must target the LOCAL dev DB, never production. Load
// `.env.local` ONLY — do not fall back to `.env`, which typically holds
// the Supabase production URL. If `.env.local` is missing, refuse loudly:
// the operator needs to notice, not silently hit prod. The localhost host
// guard below remains as belt-and-braces.
if (!existsSync(".env.local")) {
  console.error(
    "Refusing — .env.local not found. Seeders must run against the local\n" +
      "dev DB. Create .env.local with a localhost DATABASE_URL (see\n" +
      "AGENTS.md 'Dev DB vs Prod DB — separated').",
  );
  process.exit(1);
}
loadEnv({ path: ".env.local" });

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("Refusing — DATABASE_URL not set in .env.local.");
  process.exit(1);
}
const host = new URL(dbUrl).host;
if (!host.startsWith("localhost") && !host.startsWith("127.0.0.1")) {
  console.error(`Refusing — DATABASE_URL host is ${host}, not localhost.`);
  process.exit(1);
}

const wipe = process.argv.includes("--wipe");

const c = new Client({ connectionString: dbUrl });
await c.connect();

try {
  const g = await c.query(
    `SELECT id FROM "Garage" WHERE name ILIKE '%demo%' LIMIT 1`,
  );
  if (!g.rows.length) throw new Error("No demo garage found.");
  const garageId = g.rows[0].id;

  if (wipe) {
    const del = await c.query(
      `DELETE FROM "PartRequest" WHERE "garageId" = $1`,
      [garageId],
    );
    console.log(`Wiped ${del.rowCount} PartRequest rows.`);
  }

  const jobs = await c.query(
    `SELECT id FROM "JobCard" WHERE "garageId" = $1 ORDER BY "createdAt" DESC LIMIT 100`,
    [garageId],
  );
  if (!jobs.rows.length) {
    throw new Error(
      "No JobCards on demo garage — cannot seed PartRequests. Create some jobs first.",
    );
  }

  const parts = await c.query(
    `SELECT id FROM "Part" WHERE "garageId" = $1 AND active = TRUE`,
    [garageId],
  );

  const techs = await c.query(
    `SELECT id FROM "User" WHERE "garageId" = $1 AND role IN ('TECH','MASTER')`,
    [garageId],
  );

  // 50 description fixtures — designed to stress the layout. Some fields
  // (partId, requestedById, note) get toggled null/set below via the row
  // index, so the same list produces a wide spread of shapes.
  const descriptions = [
    // Long multi-word names — should wrap or ellipsize cleanly
    "Front left brake pad set (semi-metallic, high-performance, dust-free)",
    "Timing belt kit including water pump, tensioner, idler pulleys and gasket",
    "Rear differential seal replacement kit with pinion bearing and crush sleeve",
    "Complete transmission overhaul kit — clutches, bands, seals, gaskets, filter",
    "Air conditioning compressor with clutch pulley and pressure switch assembly",
    // Short abbreviations
    "Oil filter",
    "Spark plug",
    "Wiper blade",
    "Air filter",
    "Cabin filter",
    // With brand + part number
    "Bosch 0 986 494 200 brake pad set",
    "Denso T-27 iridium spark plug",
    "NGK ILKAR7C6S plug (Toyota 90919-01286)",
    "Mann-Filter HU7020z oil filter cartridge",
    "Sachs SD.1 clutch kit (Ø228mm)",
    // Arabic script — RTL layout stress
    "طقم فحمات فرامل أمامي",
    "زيت محرك 5W-30 (4 لتر)",
    "بطارية 12 فولت 70 أمبير",
    "مساحات زجاج أمامي 24\"",
    "كتم صوت خلفي مع أنبوب العادم",
    // ALL CAPS
    "AC COMPRESSOR",
    "RADIATOR ASSEMBLY",
    "ALTERNATOR",
    "STARTER MOTOR",
    "FUEL PUMP",
    // Mixed case / punctuation
    "O2 sensor (upstream, pre-cat)",
    "CV joint boot — inner, drivers side",
    "Coolant hose #4 (thermostat → radiator)",
    "PCV valve + grommet",
    "Serpentine belt (8-rib, 1240mm)",
    // Numeric-heavy
    "M12x1.5 wheel bolt × 20",
    "3/8\" drive impact socket 21mm",
    "10AWG battery cable (0.5m)",
    "1L brake fluid DOT 4",
    "5L 5W-40 fully synthetic engine oil",
    // Generic
    "Brake fluid",
    "Coolant",
    "Windshield washer fluid",
    "Battery",
    "Tire (single)",
    "Headlight bulb",
    "Fuel injector",
    "Ignition coil",
    "Throttle body",
    "Mass airflow sensor",
    "Catalytic converter",
    "Muffler",
    "Shock absorber",
    "Strut mount",
    "Control arm bushing",
    "Sway bar link",
  ];

  const notes = [
    null,
    "Supplier confirmed — ETA 2 days",
    "Backorder, waiting on Bosch",
    "Local pickup from Deira, opens 9am tomorrow",
    "Called supplier — they only have OEM at 3× price, customer OK",
    null,
    "Ordered from Al Fajer, expect Wed",
    "Customer supplying own part — no PO",
    null,
    "Substitute approved by customer (aftermarket Sachs)",
    "URGENT — customer waiting at reception",
    null,
    "Will fit tomorrow morning",
    "Part arrived scratched — replacement requested",
    null,
    // Long notes
    "Original part was superseded by supplier — new part number is 90919-01286 (was 90919-01247). Confirmed compatible with 2019 vehicle. Waiting on Toyota part distributor to confirm stock at Sharjah warehouse before we commit.",
  ];

  // All 5 statuses populated so the "TERMINAL is hidden" invariant has
  // real rows behind it. The OPEN bucket is heavier (~70%) so pagination
  // has enough on-page rows to test window boundaries.
  const statusPool = [
    ...Array(15).fill("REQUESTED"),
    ...Array(12).fill("ORDERED"),
    ...Array(9).fill("ARRIVED"),
    ...Array(9).fill("FULFILLED"),
    ...Array(5).fill("CANCELLED"),
  ];

  const rows = [];
  const now = Date.now();
  for (let i = 0; i < 50; i++) {
    const description = descriptions[i % descriptions.length];
    const qty = [1, 1, 1, 2, 2, 4, 8, 16, 100][i % 9];
    const partId = parts.rows.length && i % 3 === 0
      ? parts.rows[i % parts.rows.length].id
      : null;
    const requestedById = techs.rows.length && i % 5 !== 0
      ? techs.rows[i % techs.rows.length].id
      : null;
    const note = notes[i % notes.length];
    const status = statusPool[i % statusPool.length];
    // Spread createdAt across ~30 days so orderBy asc isn't insertion order.
    const daysAgo = (i * 37) % 30;
    const createdAt = new Date(now - daysAgo * 86_400_000 - (i % 24) * 3_600_000);
    const jobCardId = jobs.rows[i % jobs.rows.length].id;
    rows.push({
      id: randomUUID(),
      garageId,
      jobCardId,
      partId,
      description,
      qty,
      status,
      requestedById,
      note,
      createdAt,
    });
  }

  // Bulk-insert. One INSERT per row keeps the code obvious — 50 rows is
  // fast enough locally that batching adds complexity for no win.
  let inserted = 0;
  for (const r of rows) {
    await c.query(
      `INSERT INTO "PartRequest"
        (id, "garageId", "jobCardId", "partId", description, qty, status,
         "requestedById", note, "createdAt", "updatedAt")
       VALUES
        ($1, $2, $3, $4, $5, $6, $7::"PartRequestStatus", $8, $9, $10, $10)`,
      [
        r.id,
        r.garageId,
        r.jobCardId,
        r.partId,
        r.description,
        r.qty,
        r.status,
        r.requestedById,
        r.note,
        r.createdAt,
      ],
    );
    inserted++;
  }

  const openCount = rows.filter((r) =>
    ["REQUESTED", "ORDERED", "ARRIVED"].includes(r.status),
  ).length;
  const terminalCount = rows.length - openCount;
  console.log(
    `Seeded ${inserted} PartRequests — ${openCount} OPEN (page shows), ` +
      `${terminalCount} TERMINAL (hidden by design).`,
  );
} finally {
  await c.end();
}
