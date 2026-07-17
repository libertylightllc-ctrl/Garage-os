// LOCAL DEV ONLY. Seeds ~50 Vehicle rows (each under a fresh Customer) on
// the demo garage so /advisor/jobs/new's vehicle picker can be paginated
// and layout-verified against varied real data.
//
//   node scripts/seed-vehicles.mjs [--wipe]
//
// HARD GUARD: refuses to run without `.env.local`, and refuses if the
// resolved DATABASE_URL host isn't localhost. Never falls back to `.env`
// (which typically holds the Supabase production URL). Matches the pattern
// used by seed-part-requests.mjs + seed-suppliers-and-pos.mjs.
//
// Marker for --wipe reruns: the seeded Customers get a `trn` value of
// "SEED-VEHICLES-<n>". TRN isn't rendered on the vehicle picker, doesn't
// collide with a real 15-digit UAE TRN, and gives us a cheap way to
// identify + reap only THIS seeder's rows.
//
// Variety by design — layout bugs surface against messy data:
//   - Customer name: long Arabic (محمد بن عبد الله الحمداني), long
//     English (ARAFATH SYED YASAR SHAFIULLA RAWOOF SYED), short, mixed
//     case, punctuation, hyphenated
//   - phone: always present (schema requires it)
//   - email: some rows have it, some don't
//   - lang: mix of ar + en
//   - vehicle.year: some rows null (schema allows)
//   - vehicle.vin: some rows null (schema allows)
//   - vehicle.engineSize: some rows null, some like "2.7", "5.7L HEMI", "2.0T"
//   - vehicle.fuelType: PETROL / DIESEL / HYBRID / ELECTRIC / null
//   - plate: always present (schema requires it — plate is String, NOT
//     String?, so a null plate is not a legal DB state today)
//   - createdAt: spread across ~90 days so orderBy: desc isn't insertion
//     order

import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

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
    // Vehicles first (FK: no ON DELETE CASCADE at Prisma layer), then the
    // seeded Customers themselves. Reap by the TRN marker so we can't
    // accidentally nuke a real customer.
    const v = await c.query(
      `DELETE FROM "Vehicle" WHERE "customerId" IN (
         SELECT id FROM "Customer" WHERE "garageId" = $1 AND trn LIKE 'SEED-VEHICLES-%'
       )`,
      [garageId],
    );
    const cust = await c.query(
      `DELETE FROM "Customer" WHERE "garageId" = $1 AND trn LIKE 'SEED-VEHICLES-%'`,
      [garageId],
    );
    console.log(
      `Wiped ${v.rowCount} seeded Vehicles and ${cust.rowCount} seeded Customers.`,
    );
  }

  // 50 customer + vehicle fixtures. Designed to stress the layout: long
  // names, missing optional fields, RTL Arabic, ALL CAPS, punctuation.
  const arabicNames = [
    "محمد بن عبد الله الحمداني",
    "فاطمة الزهراء بنت أحمد المكتومي",
    "خالد بن سلطان بن راشد النعيمي",
    "عائشة بنت راشد بن حمد الشامسي",
    "عبد الرحمن بن يوسف الفلاسي",
    "مريم بنت عبد الله الشحي",
    "علي بن حسن الظاهري",
    "نورة بنت خالد الكعبي",
  ];

  const longEnglishNames = [
    "ARAFATH SYED YASAR SHAFIULLA RAWOOF SYED",
    "ABDULRAHMAN MUHAMMAD ABDULLAH AL BALUSHI",
    "MOHAMMED SALEH ABDULRAHMAN AL SHAMSI",
    "PRIYADHARSHINI CHANDRASEKAR VENKATARAMAN",
    "VENKATA NARASIMHA MURTHY RAMAKRISHNA",
    "GERALDINE PATRICIA O'SULLIVAN-MCDONNELL",
  ];

  const normalNames = [
    "Ahmed Al Marri",
    "Sarah Chen",
    "Rajesh Kumar",
    "Priya Nair",
    "Wei Zhang",
    "Maria da Silva",
    "Hassan Al Hosani",
    "Yusuf Khan",
    "Lena Petrov",
    "Klaus Weber",
    "John Smith",
    "Mike O'Sullivan",
    "Alan Baker-Chen",
    "Jean-Pierre Moreau",
    "Björn Sørensen",
  ];

  const shortNames = ["ali", "sam", "Bo", "Ng", "Jo", "PJ"];

  const allCapsNames = [
    "RASHID SAEED",
    "TARIQ ALI",
    "OMAR ZAYED",
    "SALIM AHMED",
  ];

  const punctuationNames = [
    "Alan Baker-Chen Jr.",
    "Fatima Al-Zaabi (guardian)",
    "P.J. O'Malley III",
    "Anna-Maria Weiss-Schmidt",
  ];

  const nameFixtures = [
    ...arabicNames,
    ...longEnglishNames,
    ...normalNames,
    ...shortNames,
    ...allCapsNames,
    ...punctuationNames,
  ];

  const makes = [
    "Toyota", "Nissan", "Mitsubishi", "Honda", "Mazda", "Hyundai", "Kia",
    "Ford", "Chevrolet", "GMC", "Dodge", "Jeep", "BMW", "Mercedes-Benz",
    "Audi", "Volkswagen", "Lexus", "Infiniti", "Land Rover", "Porsche",
  ];

  const modelsByMake = {
    Toyota: ["Prado", "Land Cruiser", "Camry", "Corolla", "Hilux", "Fortuner"],
    Nissan: ["Patrol", "Sunny", "Altima", "X-Trail", "Sentra"],
    Mitsubishi: ["Pajero", "Lancer", "Outlander", "L200"],
    Honda: ["Accord", "Civic", "CR-V", "Pilot"],
    Mazda: ["6", "CX-5", "CX-9", "3"],
    Hyundai: ["Sonata", "Elantra", "Tucson", "Santa Fe", "Accent"],
    Kia: ["Sportage", "Sorento", "Cerato", "Rio"],
    Ford: ["F-150", "Explorer", "Edge", "Mustang", "Escape"],
    Chevrolet: ["Tahoe", "Suburban", "Silverado", "Malibu", "Cruze"],
    GMC: ["Yukon", "Sierra", "Acadia"],
    Dodge: ["Charger", "Challenger", "Durango", "Ram"],
    Jeep: ["Grand Cherokee", "Wrangler", "Compass"],
    BMW: ["5 Series", "7 Series", "X5", "X7", "3 Series"],
    "Mercedes-Benz": ["S-Class", "E-Class", "GLE", "GLS", "C-Class"],
    Audi: ["A6", "A8", "Q7", "Q5"],
    Volkswagen: ["Passat", "Tiguan", "Touareg"],
    Lexus: ["LX 570", "GX 460", "ES 350", "RX 350"],
    Infiniti: ["QX80", "QX60", "Q50"],
    "Land Rover": ["Range Rover", "Discovery", "Defender"],
    Porsche: ["Cayenne", "Macan", "Panamera"],
  };

  const engineSizes = [
    null, null, // some rows without
    "2.0", "2.5", "2.7", "3.0", "3.5", "4.0", "5.7L HEMI", "2.0T",
    "3.5 V6", "5.0 V8", "1.6", "6.2L V8", "3.6",
  ];

  const fuelTypes = [
    "PETROL", "PETROL", "PETROL", // most common
    "DIESEL", "DIESEL",
    "HYBRID",
    "ELECTRIC",
    null, null, // some rows without
  ];

  const langs = ["ar", "ar", "en", "en", "en"]; // 40/60 split

  const plateEmirates = ["A", "B", "C", "D", "E", "F", "K", "M", "N", "P", "S", "T", "V", "X"];
  const emirates = ["Dubai", "AUH", "SHJ", "AJM", "RAK", "UAQ", "FUJ"];

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // Random plate. UAE plates are typically "<emirate> <letter> <1-5 digits>".
  // We deliberately vary length + format to stress the layout.
  function makePlate(i) {
    const emirate = pick(emirates);
    const letter = pick(plateEmirates);
    const digits = String(Math.floor(1 + Math.random() * 99999));
    return `${emirate} ${letter} ${digits}`;
  }

  const rows = [];
  const now = Date.now();
  for (let i = 0; i < 50; i++) {
    const name = nameFixtures[i % nameFixtures.length];
    const phone = `+971 5${Math.floor(Math.random() * 10)} ${String(
      Math.floor(1000000 + Math.random() * 8999999),
    )}`;
    const hasEmail = i % 3 !== 0;
    const email = hasEmail
      ? `customer${i + 1}@example.ae`
      : null;
    const lang = pick(langs);
    const make = pick(makes);
    const model = pick(modelsByMake[make]);
    const hasYear = i % 4 !== 0;
    const year = hasYear ? 2005 + Math.floor(Math.random() * 21) : null;
    const hasVin = i % 5 !== 0;
    const vin = hasVin
      ? Array.from({ length: 17 }, () =>
          "ABCDEFGHJKLMNPRSTUVWXYZ0123456789"[
            Math.floor(Math.random() * 32)
          ],
        ).join("")
      : null;
    const engineSize = pick(engineSizes);
    const fuelType = pick(fuelTypes);
    const plate = makePlate(i);
    // Spread across ~90 days so orderBy: createdAt desc reveals real order
    const daysAgo = Math.floor((i * 47) % 90);
    const createdAt = new Date(
      now - daysAgo * 86_400_000 - (i % 24) * 3_600_000,
    );

    rows.push({
      customerId: randomUUID(),
      vehicleId: randomUUID(),
      name,
      phone,
      email,
      lang,
      trn: `SEED-VEHICLES-${i + 1}`,
      make,
      model,
      year,
      plate,
      vin,
      engineSize,
      fuelType,
      createdAt,
    });
  }

  let inserted = 0;
  for (const r of rows) {
    await c.query(
      `INSERT INTO "Customer"
        (id, "garageId", name, phone, email, lang, trn, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6::"Lang", $7, $8, $8)`,
      [
        r.customerId,
        garageId,
        r.name,
        r.phone,
        r.email,
        r.lang,
        r.trn,
        r.createdAt,
      ],
    );
    await c.query(
      `INSERT INTO "Vehicle"
        (id, "customerId", make, model, year, plate, vin, "engineSize",
         "fuelType", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        r.vehicleId,
        r.customerId,
        r.make,
        r.model,
        r.year,
        r.plate,
        r.vin,
        r.engineSize,
        r.fuelType,
        r.createdAt,
      ],
    );
    inserted++;
  }

  console.log(`Seeded ${inserted} Vehicles under ${inserted} new Customers.`);
} finally {
  await c.end();
}
