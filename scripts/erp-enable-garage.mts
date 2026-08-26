// Operator opt-in: enable ERPNext sync for one garage on Production.
//
// Usage:
//   npx tsx scripts/erp-enable-garage.mts --garage <garageId>
//   npx tsx scripts/erp-enable-garage.mts --garage <garageId> --startAt 2026-08-01T00:00:00Z
//   npx tsx scripts/erp-enable-garage.mts --garage <garageId> --disable
//
// --startAt (optional): ISO-8601 timestamp. Cursor is seeded so the
//   tailer picks up only ledger rows created STRICTLY AFTER this
//   moment. Default = now — no backfill of historical events.
//
// Explicit choice: pass a past --startAt only when the shop actually
// wants their history in ERPNext. §7 of ERPNEXT_SYNC_BRIEF.md and
// the note in src/lib/erp-sync/enable.ts explain why.
//
// --disable: flips the flag off, LEAVES the cursor in place. A shop
//   that pauses for a dispute and resumes doesn't skip the dispute
//   window's events. To restart-from-now, delete the ErpSyncCursor
//   row explicitly then re-enable.
import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";
import {
    enableErpSyncForGarage,
    disableErpSyncForGarage,
} from "../src/lib/erp-sync/enable";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const v = process.argv[i + 1];
    if (!v || v.startsWith("--")) return undefined;
    return v;
}

const garageId = arg("garage");
const startAtRaw = arg("startAt");
const disable = process.argv.includes("--disable");

if (!garageId) {
    console.error("Missing --garage <garageId>");
    process.exit(1);
}

if (disable) {
    await disableErpSyncForGarage({ garageId });
    console.log(`[erp-enable] disabled garage=${garageId}`);
    process.exit(0);
}

const startAt = startAtRaw ? new Date(startAtRaw) : new Date();
if (Number.isNaN(startAt.getTime())) {
    console.error(`Invalid --startAt: ${startAtRaw}`);
    process.exit(1);
}

const result = await enableErpSyncForGarage({ garageId, startAt });

if (result.cursorCreated) {
    console.log(
        `[erp-enable] enabled garage=${garageId} startAt=${result.startAt.toISOString()} cursorCreated=true`,
    );
} else {
    console.log(
        `[erp-enable] enabled garage=${garageId} cursorCreated=false (existing cursor at ${result.startAt.toISOString()} — resume from there; delete the ErpSyncCursor row first if you want to restart from now)`,
    );
}

await prisma.$disconnect();
