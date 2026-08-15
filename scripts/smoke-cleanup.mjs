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

const platePrefix = `SMK-${runId}-%`; // SQL LIKE pattern
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

try {
    const invLines = await del(
        `DELETE FROM "InvoiceLine" WHERE "invoiceId" IN (
             SELECT i.id FROM "Invoice" i
             JOIN "JobCard" jc ON jc.id = i."jobCardId"
             JOIN "Vehicle" v ON v.id = jc."vehicleId"
             WHERE v.plate LIKE $1
         )`,
        [platePrefix],
    );
    const invoices = await del(
        `DELETE FROM "Invoice" WHERE "jobCardId" IN (
             SELECT jc.id FROM "JobCard" jc
             JOIN "Vehicle" v ON v.id = jc."vehicleId"
             WHERE v.plate LIKE $1
         )`,
        [platePrefix],
    );
    const estLines = await del(
        `DELETE FROM "EstimateLine" WHERE "estimateId" IN (
             SELECT e.id FROM "Estimate" e
             JOIN "JobCard" jc ON jc.id = e."jobCardId"
             JOIN "Vehicle" v ON v.id = jc."vehicleId"
             WHERE v.plate LIKE $1
         )`,
        [platePrefix],
    );
    const estimates = await del(
        `DELETE FROM "Estimate" WHERE "jobCardId" IN (
             SELECT jc.id FROM "JobCard" jc
             JOIN "Vehicle" v ON v.id = jc."vehicleId"
             WHERE v.plate LIKE $1
         )`,
        [platePrefix],
    );
    const jobs = await del(
        `DELETE FROM "JobCard" WHERE "vehicleId" IN (
             SELECT id FROM "Vehicle" WHERE plate LIKE $1
         )`,
        [platePrefix],
    );
    const vehicles = await del(
        `DELETE FROM "Vehicle" WHERE plate LIKE $1`,
        [platePrefix],
    );
    const customers = await del(
        `DELETE FROM "Customer" WHERE name = $1`,
        [smokeName],
    );

    console.log(
        `::notice title=smoke cleanup::runId=${runId} deleted invoiceLine=${invLines} invoice=${invoices} estimateLine=${estLines} estimate=${estimates} jobCard=${jobs} vehicle=${vehicles} customer=${customers}`,
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
