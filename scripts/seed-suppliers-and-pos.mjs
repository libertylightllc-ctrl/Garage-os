// LOCAL DEV ONLY. Seeds ~50 Suppliers and ~50 Purchase Orders on the demo
// garage so pagination + layout can be verified against varied real data.
//
//   node scripts/seed-suppliers-and-pos.mjs [--wipe]
//
// HARD GUARD: refuses to run against anything but a localhost DATABASE_URL.
// The demo garage must exist. --wipe first deletes any existing seeded
// rows on the demo garage (deterministic reruns).
//
// Variety by design — layout bugs only surface against messy data:
//   - Names: long L.L.C., short single-word, Arabic script, mixed-case,
//     ALL-CAPS, numbers, punctuation
//   - contactPerson: some rows have it, some don't
//   - phone: some rows have it, some don't
//   - email: some rows have it, some don't
//   - trn: some rows have a 15-digit TRN, some have empty string, some null
//   - address: some long multi-line, some short, some absent
//
// PurchaseOrder statuses: all five populated (DRAFT / ORDERED /
// PARTIALLY_RECEIVED / RECEIVED / CANCELLED) so every section on the
// purchasing page renders with real rows.

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
    // Cascade delete order: PO lines → POs → Suppliers (skip parts).
    const l = await c.query(
      `DELETE FROM "PurchaseOrderLine" WHERE "purchaseOrderId" IN (
         SELECT id FROM "PurchaseOrder" WHERE "garageId" = $1
       )`,
      [garageId],
    );
    const p = await c.query(
      `DELETE FROM "PurchaseOrder" WHERE "garageId" = $1`,
      [garageId],
    );
    const s = await c.query(
      `DELETE FROM "Supplier" WHERE "garageId" = $1`,
      [garageId],
    );
    console.log(
      `Wiped ${l.rowCount} PO lines, ${p.rowCount} POs, ${s.rowCount} Suppliers.`,
    );
  }

  // 50 supplier fixtures, varied to stress the layout.
  const supplierFixtures = [
    // Long L.L.C. names
    { name: "PACE FOODSTUFF TRADING (L.L.C)", contactPerson: "Rajesh Kumar", phone: "+971 4 555 1234", email: "purchase@pace-trading.ae", trn: "100000000000001", address: "Warehouse 12, Dubai Industrial City, Dubai, UAE" },
    { name: "AL FAJER GENERAL AUTOMOTIVE PARTS & ACCESSORIES TRADING L.L.C.", contactPerson: "Ahmed Al Marri", phone: "+971 4 285 6688", email: "sales@alfajer-auto.ae", trn: "100000000000002", address: "Sharjah Industrial 5" },
    { name: "GULF MASTER SPARE PARTS TRADING COMPANY (L.L.C)", contactPerson: null, phone: "+971 6 599 4477", email: "info@gulfmaster.ae", trn: "100000000000003", address: "Ajman Free Zone, Warehouse Block B" },
    // Short names
    { name: "NAPA", contactPerson: "Mike O'Sullivan", phone: "+971 4 111 2222", email: "orders@napa.ae", trn: "100000000000004", address: "Deira, Dubai" },
    { name: "Bosch", contactPerson: "Klaus Weber", phone: "+971 4 555 9911", email: "trade@bosch-me.ae", trn: "100000000000005", address: "Dubai World Central" },
    { name: "3M", contactPerson: null, phone: "+971 4 331 0055", email: "trade.uae@3m.com", trn: "100000000000006", address: null },
    // Arabic names
    { name: "شركة الخليج لقطع الغيار", contactPerson: "خالد بن سلطان", phone: "+971 4 273 5566", email: "info@khaleej-parts.ae", trn: "100000000000007", address: "شارع الشيخ زايد، دبي" },
    { name: "مؤسسة النور للسيارات", contactPerson: "علي حسن", phone: "+971 6 741 2233", email: null, trn: "100000000000008", address: "الشارقة" },
    { name: "قطع غيار الإمارات", contactPerson: null, phone: null, email: null, trn: null, address: null },
    // Missing / partial contact info
    { name: "Sharjah Auto Spares", contactPerson: null, phone: null, email: "sales@shj-spares.ae", trn: "100000000000010", address: "Industrial 12, Sharjah" },
    { name: "Emirates Motor Company", contactPerson: "Fatima Al Zaabi", phone: null, email: null, trn: "100000000000011", address: "Abu Dhabi, Musaffah 45" },
    { name: "Al Ain Parts", contactPerson: "John Smith", phone: "+971 3 764 8899", email: null, trn: null, address: null },
    // Empty TRN (walk-in / cash-only supplier)
    { name: "Ras Al Khaimah Motor Trading", contactPerson: "Omar Zayed", phone: "+971 7 233 4455", email: "sales@rak-motor.ae", trn: "", address: "RAK Free Trade Zone" },
    // ALL CAPS
    { name: "AUTO GENIUS TRADING CO", contactPerson: "SUNIL K.", phone: "+971 4 288 3311", email: "PROCUREMENT@AUTOGENIUS.AE", trn: "100000000000014", address: "AL QUOZ IND 3, DUBAI" },
    { name: "MEGA PARTS FZE", contactPerson: null, phone: "+971 4 555 8888", email: "info@megaparts-fze.ae", trn: "100000000000015", address: "Jebel Ali Free Zone" },
    // Numbers / punctuation
    { name: "24/7 Auto Supply", contactPerson: "Rob D.", phone: "+971 4 777 0007", email: "orders@247auto.ae", trn: "100000000000016", address: "Al Rashidiya, Dubai" },
    { name: "A.B.C. Parts & Co.", contactPerson: "Alan Baker-Chen", phone: "+971 4 300 3003", email: "hello@abc-parts.ae", trn: "100000000000017", address: null },
    // Mixed case
    { name: "iParts Middle East", contactPerson: "Sanjay Menon", phone: "+971 4 411 8899", email: "sanjay@iparts-me.com", trn: "100000000000018", address: "Business Bay, Dubai" },
    { name: "eParts.ae", contactPerson: null, phone: "+971 4 800 3727", email: "support@eparts.ae", trn: "100000000000019", address: "Online only" },
    // Very long addresses
    { name: "Al Habtoor Motors LLC", contactPerson: "Tariq Al Habtoor", phone: "+971 4 269 3333", email: "parts@habtoormotors.ae", trn: "100000000000020", address: "Building 5, Al Habtoor Business Tower, Sheikh Zayed Road, Al Barsha South, Dubai, United Arab Emirates" },
  ];
  // Fill up to 50 with generic varied fixtures
  const cities = ["Dubai", "Sharjah", "Abu Dhabi", "Ajman", "RAK", "Fujairah", "Al Ain"];
  const suffixes = ["Trading LLC", "Motors", "Parts", "Auto Supplies", "Automotive Co", "Group", "Spares", "FZE", "Ltd"];
  const firstNames = ["Ahmed", "Sara", "Vinod", "Priya", "Wei", "Maria", "Hassan", "Yusuf", "Lena", "Chen"];
  const lastNames = ["Khan", "Rao", "Chowdhury", "Al Mansoori", "Wu", "Da Silva", "Al Ali", "Nakamura", "Petrov", "Zhang"];
  let n = supplierFixtures.length;
  while (supplierFixtures.length < 50) {
    const i = supplierFixtures.length;
    const city = cities[i % cities.length];
    const suffix = suffixes[i % suffixes.length];
    const hasContact = i % 3 !== 0;
    const hasPhone = i % 4 !== 0;
    const hasEmail = i % 5 !== 0;
    const hasTrn = i % 6 !== 0;
    supplierFixtures.push({
      name: `${city} ${suffix} #${n + 1}`,
      contactPerson: hasContact ? `${firstNames[i % firstNames.length]} ${lastNames[i % lastNames.length]}` : null,
      phone: hasPhone ? `+971 ${4 + (i % 5)} ${String(100 + i).padStart(3, "0")} ${String(1000 + i * 7).slice(-4)}` : null,
      email: hasEmail ? `contact${n + 1}@${city.toLowerCase().replace(/\s/g, "")}.ae` : null,
      trn: hasTrn ? `10000000000${String(n + 1).padStart(4, "0")}` : null,
      address: `${city}, District ${1 + (i % 12)}`,
    });
    n++;
  }

  const supplierIds = [];
  for (const s of supplierFixtures) {
    const id = `sup-${randomUUID().slice(0, 8)}`;
    await c.query(
      `INSERT INTO "Supplier" (id, "garageId", name, "contactPerson", phone, email, trn, address, active, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW(), NOW())`,
      [id, garageId, s.name, s.contactPerson, s.phone, s.email, s.trn, s.address],
    );
    supplierIds.push(id);
  }
  console.log(`Inserted ${supplierIds.length} Suppliers.`);

  // 50 POs distributed across all 5 statuses so every section on the
  // purchasing page renders with rows. Small offsets on orderedAt /
  // receivedAt so the ordering has meaningful spread.
  const statuses = [
    "DRAFT",              // 10
    "ORDERED",            // 12
    "PARTIALLY_RECEIVED", // 10
    "RECEIVED",           // 10
    "CANCELLED",          // 8
  ];
  const counts = { DRAFT: 10, ORDERED: 12, PARTIALLY_RECEIVED: 10, RECEIVED: 10, CANCELLED: 8 };
  let poCount = 0;
  for (const status of statuses) {
    for (let i = 0; i < counts[status]; i++) {
      const supId = supplierIds[poCount % supplierIds.length];
      const daysAgo = poCount * 2 + (statuses.indexOf(status) * 3);
      const createdAt = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
      const orderedAt = status !== "DRAFT" ? new Date(createdAt.getTime() + 4 * 3600 * 1000) : null;
      const receivedAt = (status === "RECEIVED" || status === "PARTIALLY_RECEIVED")
        ? new Date(createdAt.getTime() + 5 * 24 * 3600 * 1000)
        : null;
      // Vary the reference field too
      const hasRef = poCount % 3 !== 0;
      const hasNote = poCount % 5 === 0;
      await c.query(
        `INSERT INTO "PurchaseOrder" (id, "garageId", "supplierId", status, reference, note, "orderedAt", "receivedAt", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          `po-${randomUUID().slice(0, 8)}`,
          garageId,
          supId,
          status,
          hasRef ? `Q-${2026}-${String(1000 + poCount).padStart(5, "0")}` : null,
          hasNote ? `Note for PO #${poCount + 1}: expedite shipping, urgent for a customer.` : null,
          orderedAt,
          receivedAt,
          createdAt,
        ],
      );
      poCount++;
    }
  }
  console.log(`Inserted ${poCount} Purchase Orders across ${statuses.length} statuses.`);
  console.log(`Status breakdown:`, counts);
} finally {
  await c.end();
}
