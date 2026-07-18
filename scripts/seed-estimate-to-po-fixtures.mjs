// LOCAL DEV ONLY. Seeds two JobCards on the demo garage so the
// Estimate → PO conversion flow can be exercised end-to-end:
//
//   1. "Golden path" job: APPROVED estimate with a mix of lines so ONE
//      click exercises the convertible path AND all three skip/exclude
//      reasons at once:
//        - 2 PART lines WITH partId (convertible, ticked by default)
//        - 1 PART line with NO partId (should be skipped, "add to inventory")
//        - 1 declined PART line (should be skipped, "customer declined")
//        - 1 LABOR line (should be excluded entirely — not surfaced)
//
//   2. "Rejected only" job: single REJECTED estimate, so the
//      "no usable estimate" branch renders on demand.
//
//   node scripts/seed-estimate-to-po-fixtures.mjs
//
// HARD GUARD: refuses to run against anything but a localhost DATABASE_URL
// (same guard shape as seed-suppliers-and-pos.mjs).
//
// Additive only. Never wipes. Reruns will insert additional job cards with
// fresh numbers; each run prints "created JC-{year}-{number}" so you know
// which one to type into the /owner/purchasing/from-estimate lookup.

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

const c = new Client({ connectionString: dbUrl });
await c.connect();

const cuid = () => `cuid_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

function fmt(num, year) {
    return `JC-${year}-${String(num).padStart(4, "0")}`;
}

try {
    // Demo garage — same lookup pattern the other seeders use.
    const g = await c.query(
        `SELECT id FROM "Garage" WHERE name ILIKE '%demo%' LIMIT 1`,
    );
    if (!g.rows.length) throw new Error("No demo garage found.");
    const garageId = g.rows[0].id;

    // Get or create a customer + vehicle. Reuse an existing demo one if
    // possible so we don't create noise per run; if none exists, mint one.
    let customerId, vehicleId;
    const cust = await c.query(
        `SELECT id FROM "Customer" WHERE "garageId" = $1 LIMIT 1`,
        [garageId],
    );
    if (cust.rows.length) {
        customerId = cust.rows[0].id;
        const veh = await c.query(
            `SELECT id FROM "Vehicle" WHERE "customerId" = $1 LIMIT 1`,
            [customerId],
        );
        if (veh.rows.length) vehicleId = veh.rows[0].id;
    }
    if (!customerId) {
        customerId = cuid();
        await c.query(
            `INSERT INTO "Customer" (id, "garageId", name, phone, lang, "createdAt", "updatedAt")
             VALUES ($1, $2, 'Estimate-to-PO Fixture Customer', '+971 50 000 0000', 'ar', NOW(), NOW())
             ON CONFLICT ("garageId", phone) DO NOTHING`,
            [customerId, garageId],
        );
    }
    if (!vehicleId) {
        vehicleId = cuid();
        await c.query(
            `INSERT INTO "Vehicle" (id, "customerId", make, model, year, plate, "createdAt", "updatedAt")
             VALUES ($1, $2, 'Toyota', 'Prado', 2018, 'FIX-001', NOW(), NOW())`,
            [vehicleId, customerId],
        );
    }
    console.log(`Using customerId=${customerId}, vehicleId=${vehicleId}`);

    // Get or create two Parts we can link estimate lines to. Reuse existing
    // active parts on the garage if there are ≥ 2; otherwise mint what we
    // need. The parts flow into the PO regardless of whether they were
    // seeded here or already existed.
    async function ensureParts() {
        const existing = await c.query(
            `SELECT id, name, cost FROM "Part"
              WHERE "garageId" = $1 AND active = TRUE
              ORDER BY "createdAt" DESC
              LIMIT 2`,
            [garageId],
        );
        if (existing.rows.length >= 2) return existing.rows;
        const rows = [...existing.rows];
        const skus = [
            {
                sku: `E2PO-BRAKE-${Date.now().toString(36)}`,
                name: "Brake pad — front (fixture)",
                cost: "45.00",
                price: "80.00",
            },
            {
                sku: `E2PO-FILTER-${Date.now().toString(36)}`,
                name: "Oil filter (fixture)",
                cost: "18.50",
                price: "35.00",
            },
        ];
        for (const s of skus) {
            if (rows.length >= 2) break;
            const id = cuid();
            await c.query(
                `INSERT INTO "Part" (id, "garageId", sku, name, "qtyOnHand", cost, price, "reorderLevel", active, "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, $4, 10, $5::numeric, $6::numeric, 5, TRUE, NOW(), NOW())`,
                [id, garageId, s.sku, s.name, s.cost, s.price],
            );
            rows.push({ id, name: s.name, cost: s.cost });
        }
        return rows;
    }
    const [partA, partB] = await ensureParts();
    console.log(
        `Parts to link: A="${partA.name}" (cost ${partA.cost}), B="${partB.name}" (cost ${partB.cost})`,
    );

    // Next per-garage job number — uses the SAME atomic counter the real
    // intake path uses (src/app/actions/intake-moulkia.ts:320-325):
    //
    //   UPDATE "Garage" SET "jobSeq" = "jobSeq" + 1 RETURNING "jobSeq"
    //
    // Real intake does this via `garage.update({ data: { jobSeq: { increment: 1 } } })`
    // which compiles to essentially this SQL, row-locked. Seeder and intake
    // now share ONE numbering mechanism, so they can't drift.
    //
    // The previous MAX(number)+1 approach was wrong: it read from JobCard
    // but never touched Garage.jobSeq, leaving jobSeq behind the actual
    // max. The next real intake would then increment jobSeq to a number
    // the seeder already wrote and hit the (garageId, number) unique
    // constraint. This function fixes that by construction — every number
    // the seeder issues also advances jobSeq.
    async function nextJobNumber() {
        const r = await c.query(
            `UPDATE "Garage" SET "jobSeq" = "jobSeq" + 1 WHERE id = $1 RETURNING "jobSeq"`,
            [garageId],
        );
        if (r.rows.length === 0) {
            throw new Error(`Garage ${garageId} not found`);
        }
        return r.rows[0].jobSeq;
    }

    // ---- Job 1: golden path (APPROVED estimate with mixed lines) ----
    const goldenJobId = cuid();
    const goldenJobNumber = await nextJobNumber();
    const year = new Date().getFullYear();
    await c.query(
        `INSERT INTO "JobCard" (id, "garageId", "vehicleId", status, number, complaint, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'APPROVED', $4, 'Estimate → PO fixture — golden path', NOW(), NOW())`,
        [goldenJobId, garageId, vehicleId, goldenJobNumber],
    );

    // APPROVED estimate. Subtotal/vat/total figures are illustrative — the
    // conversion flow ignores them (PO uses inventory cost).
    const approvedEstimateId = cuid();
    await c.query(
        `INSERT INTO "Estimate" (id, "jobCardId", subtotal, "vatAmount", total, status, "sentAt", "approvedAt", "approvedAmount", "createdAt", "updatedAt")
         VALUES ($1, $2, 250.00, 12.50, 262.50, 'APPROVED', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day', 262.50, NOW(), NOW())`,
        [approvedEstimateId, goldenJobId],
    );

    // 5 lines: 2 convertible PART, 1 no-partId PART, 1 declined PART, 1 LABOR.
    const lines = [
        {
            id: cuid(),
            kind: "PART",
            partId: partA.id,
            description: partA.name,
            qty: "2",
            unitPrice: "80.00",
            lineTotal: "160.00",
            declined: false,
        },
        {
            id: cuid(),
            kind: "PART",
            partId: partB.id,
            description: partB.name,
            qty: "1",
            unitPrice: "35.00",
            lineTotal: "35.00",
            declined: false,
        },
        {
            id: cuid(),
            kind: "PART",
            partId: null, // no inventory link — should be skipped
            description: "Brake sensor (fixture — no inventory link)",
            qty: "1",
            unitPrice: "60.00",
            lineTotal: "60.00",
            declined: false,
        },
        {
            id: cuid(),
            kind: "PART",
            partId: partA.id, // linked, but declined
            description: "Extra pad set — customer declined (fixture)",
            qty: "1",
            unitPrice: "80.00",
            lineTotal: "80.00",
            declined: true,
        },
        {
            id: cuid(),
            kind: "LABOR",
            partId: null,
            description: "Labour — brake job (fixture)",
            qty: "1",
            unitPrice: "150.00",
            lineTotal: "150.00",
            declined: false,
        },
    ];
    for (const l of lines) {
        await c.query(
            `INSERT INTO "EstimateLine" (id, "estimateId", kind, "partId", description, qty, "unitPrice", "lineTotal", declined, "createdAt", "updatedAt")
             VALUES ($1, $2, $3::"LineKind", $4, $5, $6::numeric, $7::numeric, $8::numeric, $9, NOW(), NOW())`,
            [
                l.id,
                approvedEstimateId,
                l.kind,
                l.partId,
                l.description,
                l.qty,
                l.unitPrice,
                l.lineTotal,
                l.declined,
            ],
        );
    }

    // ---- Job 2: rejected-only (branch: "no usable estimate") ----
    const rejectedJobId = cuid();
    const rejectedJobNumber = await nextJobNumber();
    await c.query(
        `INSERT INTO "JobCard" (id, "garageId", "vehicleId", status, number, complaint, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'APPROVED', $4, 'Estimate → PO fixture — rejected only', NOW(), NOW())`,
        [rejectedJobId, garageId, vehicleId, rejectedJobNumber],
    );
    const rejectedEstimateId = cuid();
    await c.query(
        `INSERT INTO "Estimate" (id, "jobCardId", subtotal, "vatAmount", total, status, "sentAt", "createdAt", "updatedAt")
         VALUES ($1, $2, 100.00, 5.00, 105.00, 'REJECTED', NOW() - INTERVAL '3 days', NOW(), NOW())`,
        [rejectedEstimateId, rejectedJobId],
    );
    await c.query(
        `INSERT INTO "EstimateLine" (id, "estimateId", kind, "partId", description, qty, "unitPrice", "lineTotal", declined, "createdAt", "updatedAt")
         VALUES ($1, $2, 'PART'::"LineKind", $3, 'Would-be part (rejected estimate)', 1, 100.00, 100.00, FALSE, NOW(), NOW())`,
        [cuid(), rejectedEstimateId, partA.id],
    );

    console.log("");
    console.log("=== Fixture jobs created ===");
    console.log(
        `Golden path (APPROVED, mixed lines):   ${fmt(goldenJobNumber, year)}   → type ${goldenJobNumber} in the lookup`,
    );
    console.log(
        `Rejected-only (no-usable-estimate):    ${fmt(rejectedJobNumber, year)}   → type ${rejectedJobNumber}`,
    );
    console.log("");
} finally {
    await c.end();
}
