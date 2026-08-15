#!/usr/bin/env node
/**
 * Best-effort DB cleanup for the smoke suite.
 *
 * Deletes rows created by a specific run (STAGING_SMOKE_RUN_ID). Every
 * customer / vehicle / booking a flow spec creates carries the run id
 * in its distinctive identifier (plate: `SMK-<runId>-<letter>`, name:
 * `Smoke Test <runId>`), so we can find our own debris without a
 * broader wipe.
 *
 * Fail-loud contract (AR 2026-08-12): if the secret is missing OR
 * points at a Prod-shaped URL, exit 1 with a red banner. AR
 * explicitly does NOT want silent skips — a weekly stretch of "the
 * cleanup step is skipping because the secret got removed and nobody
 * noticed" is exactly the failure mode we're avoiding here.
 *
 * Raw pg (AR 2026-08-15). The previous version imported PrismaClient
 * from `../src/generated/prisma/client/index.js` — a path that has
 * never existed. Prisma 7's generator emits pure TypeScript at
 * `../src/generated/prisma/*.ts`, and Node `.mjs` can't import `.ts`
 * without a runner. Only surfaced now because cleanup had never
 * reached this import — earlier failures (missing secret, stale
 * password) exited before line 43. Raw pg with parameterised SQL
 * matches the pattern in tests/smoke/support/flows.ts and removes
 * the Prisma-runtime dependency the cleanup step never needed.
 */

import pg from "pg";

const url = process.env.STAGING_DATABASE_URL;
const runId = process.env.STAGING_SMOKE_RUN_ID;

if (!url) {
    console.error(
        "::error::STAGING_DATABASE_URL secret missing — cleanup cannot run. Add it under GitHub → repo Settings → Secrets and variables → Actions.",
    );
    process.exit(1);
}
if (!runId) {
    console.error(
        "::error::STAGING_SMOKE_RUN_ID env var missing — refusing to run cleanup without a run-scoped filter (would risk deleting other runs' rows).",
    );
    process.exit(1);
}
// Belt-and-braces: never point cleanup at a URL that looks like Prod.
// The smoke suite has no business touching real customer data even if
// the secret were misconfigured.
if (/@garageos\.|prod|production/i.test(url)) {
    console.error(
        "::error::STAGING_DATABASE_URL looks like a Prod URL. Refusing to run cleanup.",
    );
    process.exit(1);
}

// smokePlate(letter) types "SMK-<runId>-<letter>", but the intake
// action's normalizePlate() strips dashes + uppercases before writing:
//   normalizePlate("SMK-31887657706-A") === "SMK31887657706A"
// So the value stored in Vehicle.plate has NO dashes. The old pattern
// `SMK-<runId>-%` never matched, vehicles stayed in the DB, and the
// subsequent DELETE FROM Customer FK-failed on Vehicle_customerId_fkey.
// AR 2026-08-15 caught this on run #30.
//
// Match the normalized form. `_` is SQL LIKE's single-char wildcard —
// tighter than `%` and safe because smokePlate's letter is always
// exactly one character (A/B/C/D/E). Using `%` would risk matching a
// longer run id starting with this one (e.g. SMK1234 vs SMK12345).
const platePattern = `SMK${runId}_`;
const smokeName = `Smoke Test ${runId}`;

const client = new pg.Client({ connectionString: url });
await client.connect();

// Order matters — child rows first, then parents. Any join column
// this script doesn't cover is safe to skip; the next run's fresh
// prefix keeps them from interfering, and the weekly reseed
// eventually clears everything.
//
// SQL mirrors the previous Prisma deleteMany chains: each level's
// filter is a subquery on the plate prefix reached through the join
// tree. Parameterised to keep the LIKE-pattern out of any SQL-injection
// concern even though the run-id is our own env var.
async function del(sql, params) {
    const r = await client.query(sql, params);
    return r.rowCount ?? 0;
}

// Deletion order (children first). Audited against
// prisma/schema.prisma's FK graph. Every table with a FK column
// pointing at Customer / Vehicle / JobCard / Estimate / Invoice
// has to be swept before its parent, or DELETE FROM the parent
// fires an FK violation.
//
// Full parent-child map (only relations without ON DELETE CASCADE /
// SET NULL — Cascade rows disappear automatically with their parent,
// SET NULL rows unhook themselves):
//
//   Invoice     ← Payment, InvoiceLine
//                 (InvoiceSend has onDelete: Cascade, no explicit
//                  delete needed but harmless)
//   Estimate    ← EstimateLine
//   JobCard     ← WorkSession, JobHelper, JobPart, JobStep,
//                 JobFinding, PartRequest, AdvancePayment,
//                 PartMovement (nullable jobCardId, RESTRICT),
//                 Reminder (nullable jobCardId, RESTRICT),
//                 Estimate, Invoice
//   Vehicle     ← Reminder (vehicleId not nullable), JobCard, Booking
//                 (nullable vehicleId, RESTRICT)
//                 (VehiclePlateHistory + VehicleOwnershipTransfer
//                  have onDelete: Cascade, gone with Vehicle)
//                 (PurchaseOrderLine.vehicleId has onDelete: SetNull —
//                  the row survives, its vehicle pointer nulls out;
//                  the smoke run does not care about POs)
//   Customer    ← Vehicle, Booking, WhatsAppThread
//
// Prior misses caught the hard way:
//   #30 — Vehicle_customerId_fkey (plate LIKE pattern didn't match
//         the normalized stored value → 0 vehicles deleted → Customer
//         delete blocked)
//   #32 — WorkSession_jobCardId_fkey (tech workflow creates WorkSession
//         via the claim action)
//
// Order below sweeps every listed child before its parent. Empty
// DELETE rows are cheap (single query with 0 rowCount), so it is fine
// to include tables smoke does not touch today — they cost nothing
// and stop the next added flow from breaking cleanup.
// Shared subqueries — every child DELETE selects rows attached to a
// JobCard whose vehicle's plate matches the run's prefix. Written as
// SQL literals rather than JS templates so the intent stays in each
// statement.
const JC_BY_PLATE = `
    SELECT jc.id FROM "JobCard" jc
    JOIN "Vehicle" v ON v.id = jc."vehicleId"
    WHERE v.plate LIKE $1
`;
const INV_BY_PLATE = `
    SELECT i.id FROM "Invoice" i
    JOIN "JobCard" jc ON jc.id = i."jobCardId"
    JOIN "Vehicle" v ON v.id = jc."vehicleId"
    WHERE v.plate LIKE $1
`;
const EST_BY_PLATE = `
    SELECT e.id FROM "Estimate" e
    JOIN "JobCard" jc ON jc.id = e."jobCardId"
    JOIN "Vehicle" v ON v.id = jc."vehicleId"
    WHERE v.plate LIKE $1
`;
const V_BY_PLATE = `SELECT id FROM "Vehicle" WHERE plate LIKE $1`;

try {
    // Invoice children
    const payments = await del(`DELETE FROM "Payment" WHERE "invoiceId" IN (${INV_BY_PLATE})`, [platePattern]);
    const invLines = await del(`DELETE FROM "InvoiceLine" WHERE "invoiceId" IN (${INV_BY_PLATE})`, [platePattern]);
    const invoices = await del(`DELETE FROM "Invoice" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);

    // Estimate children
    const estLines = await del(`DELETE FROM "EstimateLine" WHERE "estimateId" IN (${EST_BY_PLATE})`, [platePattern]);
    const estimates = await del(`DELETE FROM "Estimate" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);

    // JobCard children (order within this group doesn't matter — none
    // reference each other, all reference JobCard).
    const workSessions = await del(`DELETE FROM "WorkSession" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);
    const jobHelpers = await del(`DELETE FROM "JobHelper" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);
    const jobParts = await del(`DELETE FROM "JobPart" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);
    const jobSteps = await del(`DELETE FROM "JobStep" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);
    const jobFindings = await del(`DELETE FROM "JobFinding" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);
    const partRequests = await del(`DELETE FROM "PartRequest" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);
    const advPayments = await del(`DELETE FROM "AdvancePayment" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);
    const partMovements = await del(`DELETE FROM "PartMovement" WHERE "jobCardId" IN (${JC_BY_PLATE})`, [platePattern]);
    // Reminder points at BOTH JobCard (nullable) and Vehicle (not nullable) —
    // need to delete the plate-matched ones before JobCard OR Vehicle.
    const reminders = await del(`DELETE FROM "Reminder" WHERE "vehicleId" IN (${V_BY_PLATE})`, [platePattern]);

    // JobCard
    const jobs = await del(`DELETE FROM "JobCard" WHERE "vehicleId" IN (${V_BY_PLATE})`, [platePattern]);

    // Vehicle children (Booking has nullable vehicleId + nullable jobCardId
    // reverse-relation; the customerId is on Booking, so we filter by that
    // via the smoke customer join).
    const bookingsByVehicle = await del(`DELETE FROM "Booking" WHERE "vehicleId" IN (${V_BY_PLATE})`, [platePattern]);

    // Vehicle
    const vehicles = await del(`DELETE FROM "Vehicle" WHERE plate LIKE $1`, [platePattern]);

    // Customer children (any remaining Bookings + WhatsAppThreads that
    // reference the smoke customer directly, e.g. from a prior flow that
    // did not attach a vehicleId).
    const bookingsByCustomer = await del(`DELETE FROM "Booking" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE name = $1)`, [smokeName]);
    // WhatsAppMessage.threadId → WhatsAppThread (RESTRICT). Sweep
    // messages before threads; run #33 caught this class of leak.
    const waMessages = await del(`DELETE FROM "WhatsAppMessage" WHERE "threadId" IN (SELECT wt.id FROM "WhatsAppThread" wt JOIN "Customer" ct ON ct.id = wt."customerId" WHERE ct.name = $1)`, [smokeName]);
    const waThreads = await del(`DELETE FROM "WhatsAppThread" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE name = $1)`, [smokeName]);

    // Customer
    const customers = await del(`DELETE FROM "Customer" WHERE name = $1`, [smokeName]);

    console.log(
        `::notice title=smoke cleanup::runId=${runId} deleted payment=${payments} invoiceLine=${invLines} invoice=${invoices} estimateLine=${estLines} estimate=${estimates} workSession=${workSessions} jobHelper=${jobHelpers} jobPart=${jobParts} jobStep=${jobSteps} jobFinding=${jobFindings} partRequest=${partRequests} advPayment=${advPayments} partMovement=${partMovements} reminder=${reminders} jobCard=${jobs} bookingByVehicle=${bookingsByVehicle} vehicle=${vehicles} bookingByCustomer=${bookingsByCustomer} waMessage=${waMessages} waThread=${waThreads} customer=${customers}`,
    );
} catch (err) {
    console.error(
        "::error::smoke cleanup failed (this run's debris will remain until weekly reseed):",
        err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
} finally {
    await client.end();
}
