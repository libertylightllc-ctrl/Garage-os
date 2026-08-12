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
 */

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

const { PrismaClient } = await import("../src/generated/prisma/client/index.js");
const prisma = new PrismaClient({ datasources: { db: { url } } });

const prefix = `SMK-${runId}-`;
const smokeName = `Smoke Test ${runId}`;

try {
    // Order matters — child rows first, then parents. Any join column
    // this script doesn't cover is safe to skip; the next run's fresh
    // prefix keeps them from interfering, and the weekly reseed
    // eventually clears everything.
    const invLines = await prisma.invoiceLine.deleteMany({
        where: { invoice: { jobCard: { vehicle: { plate: { startsWith: prefix } } } } },
    });
    const invoices = await prisma.invoice.deleteMany({
        where: { jobCard: { vehicle: { plate: { startsWith: prefix } } } },
    });
    const estLines = await prisma.estimateLine.deleteMany({
        where: { estimate: { jobCard: { vehicle: { plate: { startsWith: prefix } } } } },
    });
    const estimates = await prisma.estimate.deleteMany({
        where: { jobCard: { vehicle: { plate: { startsWith: prefix } } } },
    });
    const jobs = await prisma.jobCard.deleteMany({
        where: { vehicle: { plate: { startsWith: prefix } } },
    });
    const vehicles = await prisma.vehicle.deleteMany({
        where: { plate: { startsWith: prefix } },
    });
    const customers = await prisma.customer.deleteMany({
        where: { name: smokeName },
    });

    console.log(
        `::notice title=smoke cleanup::runId=${runId} deleted invoiceLine=${invLines.count} invoice=${invoices.count} estimateLine=${estLines.count} estimate=${estimates.count} jobCard=${jobs.count} vehicle=${vehicles.count} customer=${customers.count}`,
    );
} catch (err) {
    console.error(
        "::error::smoke cleanup failed (this run's debris will remain until weekly reseed):",
        err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
} finally {
    await prisma.$disconnect();
}
