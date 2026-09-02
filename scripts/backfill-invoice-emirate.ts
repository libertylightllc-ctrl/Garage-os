// AR 2026-09-03 — E4b backfill for existing Invoice rows.
//
// Runs AFTER the operator sets Garage.emirate in Settings for each
// tenant. Fills in Invoice.emirate for pre-cutover rows that were
// null at migration time (the migration itself was a no-op because
// emirates weren't set yet).
//
// Idempotent by construction: the WHERE clause skips invoices that
// already have an emirate, so a second run against the same tenant
// finds 0 rows and touches nothing. Also skips garages whose emirate
// is still null (nothing to backfill from).
//
// Dry-run by default. Pass --commit to actually write:
//
//   npx tsx scripts/backfill-invoice-emirate.ts           # preview
//   npx tsx scripts/backfill-invoice-emirate.ts --commit  # apply
//
// Rule 14 discloses that pre-cutover invoices carry an INFERRED
// value from the garage's current emirate. Post-cutover invoices
// are captured at generation time and never touched by this script.

import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";

const commit = process.argv.includes("--commit");
if (!commit) {
    console.log("(dry-run — pass --commit to apply)\n");
}

const garages = await prisma.garage.findMany({
    where: { emirate: { not: null } },
    select: { id: true, name: true, emirate: true },
    orderBy: { name: "asc" },
});

if (garages.length === 0) {
    console.log("No garages have emirate set — nothing to backfill.");
    console.log("Set Garage.emirate via /settings on each tenant first.");
    await prisma.$disconnect();
    process.exit(0);
}

console.log(`Found ${garages.length} garage(s) with emirate set:\n`);

let totalNullBefore = 0;
let totalNullSkippedByGarageNull = 0;
const nullGarages = await prisma.garage.count({ where: { emirate: null } });
if (nullGarages > 0) {
    const skippedInvoices = await prisma.invoice.count({
        where: { emirate: null, garage: { emirate: null } },
    });
    totalNullSkippedByGarageNull = skippedInvoices;
}

for (const g of garages) {
    // Count first — reports the same number whether we're in dry-run
    // or commit mode, and lets an operator see per-garage impact.
    const nullCount = await prisma.invoice.count({
        where: { garageId: g.id, emirate: null },
    });
    totalNullBefore += nullCount;

    if (nullCount === 0) {
        console.log(`  ${g.name} (${g.emirate}): 0 invoices need backfill — idempotent skip`);
        continue;
    }

    if (commit) {
        const result = await prisma.invoice.updateMany({
            where: { garageId: g.id, emirate: null },
            data: { emirate: g.emirate },
        });
        console.log(
            `  ${g.name} (${g.emirate}): ${result.count} invoice(s) backfilled`,
        );
    } else {
        console.log(
            `  ${g.name} (${g.emirate}): ${nullCount} invoice(s) WOULD be backfilled`,
        );
    }
}

console.log("");
console.log(`Total invoices ${commit ? "backfilled" : "that would be backfilled"}: ${totalNullBefore}`);
if (totalNullSkippedByGarageNull > 0) {
    console.log(
        `Skipped: ${totalNullSkippedByGarageNull} invoice(s) whose garage has no emirate set — ` +
            `these stay as "Unassigned" on the VAT summary. Set Garage.emirate for those ` +
            `garages and re-run.`,
    );
}

await prisma.$disconnect();
