// scripts/merge-parts.ts
//
// Merge duplicate Part rows within a single garage, one pair at a time,
// each pair in its own transaction. Repoints every FK that references
// the retiring Part onto the keeping Part, rolls stock forward, blends
// cost, and soft-retires the losing row (never hard-deletes — historical
// InvoiceLine rows still reference it by id).
//
// Targets Prod. Refuses to write without an explicit --commit flag;
// defaults to --dry-run which prints the planned effect of every pair
// without touching the DB.
//
// Usage:
//   npx tsx scripts/merge-parts.ts --input <path.json>            # --dry-run implied
//   npx tsx scripts/merge-parts.ts --input <path.json> --dry-run  # same, explicit
//   npx tsx scripts/merge-parts.ts --input <path.json> --commit   # actually writes
//
// Input JSON shape (an array):
//   [
//     {
//       "garageId":       "cmxxxxxxxxxxxxxxxxxxx",
//       "keepPartId":     "cmyyyyyyyyyyyyyyyyyyy",
//       "retirePartId":   "czzzzzzzzzzzzzzzzzzzz",
//       "note":           "optional freetext for the audit log"
//     }
//   ]
//
// Every pair MUST have both keep + retire in the same garage. The script
// re-verifies this per pair — a mismatched garage aborts the pair and
// the run continues to the next pair (per AR: one transaction per pair,
// don't roll back the whole batch on one bad row).
//
// Cost-blend rule at merge (mirrors blendPartCost's discipline):
//   - keepCost > 0 AND retireCost > 0 → weighted average by qtyOnHand
//   - keepCost > 0 AND retireCost == 0 → keep's cost wins (no change)
//   - keepCost == 0 AND retireCost > 0 → adopt retire's cost (REPLACE)
//   - both zero → stays zero
//
// FK tables repointed (5 total):
//   JobPart, PartRequest, EstimateLine, PurchaseOrderLine, PartMovement
//
// InvoiceLine is NOT in the list — it has no partId column. Every
// InvoiceLine holds a frozen snapshot (description, qty, unitCost,
// unitPrice) taken at invoice generation, so historical invoices
// need no maintenance during a merge. A nice property: closed books
// stay closed. My earlier merge-plan report said 6 FKs; the actual
// number is 5.
//
// autoCreatedFromLineId is @unique — if the retiring Part has one and
// the keeper doesn't, we null it out on the retiring row before soft-
// retire (the FK is no longer meaningful on a merged-away row). If the
// keeper already has one, no change.
//
// The retiring Part's row stays: sku is left alone (unique per garage,
// but the retire row remains uniquely holding its own sku), qtyOnHand
// is set to 0, and active is flipped to false so it drops out of every
// picker.

import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";
import { Prisma } from "../src/generated/prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface MergePair {
    garageId: string;
    keepPartId: string;
    retirePartId: string;
    note?: string;
}

interface FkCounts {
    jobPart: number;
    partRequest: number;
    estimateLine: number;
    purchaseOrderLine: number;
    partMovement: number;
}

// ── CLI parsing ───────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
}
const inputPath = argValue("--input");
const doCommit = args.includes("--commit");
const doDryRun = args.includes("--dry-run") || !doCommit;

if (!inputPath) {
    console.error("Usage: npx tsx scripts/merge-parts.ts --input <path.json> [--dry-run | --commit]");
    process.exit(2);
}
if (doCommit && args.includes("--dry-run")) {
    console.error("Refusing to run: both --commit and --dry-run set. Pick one.");
    process.exit(2);
}

// ── Input load + validate ─────────────────────────────────────────

let pairs: MergePair[];
try {
    const raw = readFileSync(resolve(inputPath), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("input must be a JSON array of pairs");
    for (const p of parsed) {
        if (
            typeof p !== "object" || p === null ||
            typeof (p as Record<string, unknown>).garageId !== "string" ||
            typeof (p as Record<string, unknown>).keepPartId !== "string" ||
            typeof (p as Record<string, unknown>).retirePartId !== "string"
        ) {
            throw new Error("each pair needs {garageId, keepPartId, retirePartId} as non-empty strings");
        }
        if ((p as MergePair).keepPartId === (p as MergePair).retirePartId) {
            throw new Error(`keep and retire are the same id: ${(p as MergePair).keepPartId}`);
        }
    }
    pairs = parsed as MergePair[];
} catch (e) {
    console.error(`Failed to parse ${inputPath}:`, e instanceof Error ? e.message : String(e));
    process.exit(2);
}

// ── Mode banner (visible before any DB touch) ─────────────────────

const BANNER = doCommit
    ? "  ⚠  --commit — WRITES WILL BE APPLIED"
    : "  ✓  --dry-run — no writes, report only";
console.log("\n=== merge-parts ===");
console.log(`  input: ${inputPath}`);
console.log(`  pairs: ${pairs.length}`);
console.log(BANNER);
console.log("");

// ── Per-pair execution ────────────────────────────────────────────

interface PairOutcome {
    pairIndex: number;
    ok: boolean;
    message: string;
    fkBefore?: FkCounts;
    stockBefore?: { keep: number; retire: number };
    stockAfter?: { keep: number; retire: number };
    costBefore?: { keep: string; retire: string };
    costAfter?: { keep: string };
}

const outcomes: PairOutcome[] = [];

function round2(d: Prisma.Decimal): Prisma.Decimal {
    return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function blendMergeCost(
    keepCost: Prisma.Decimal,
    keepQty: number,
    retireCost: Prisma.Decimal,
    retireQty: number,
): Prisma.Decimal {
    // Rules from the merge-plan report:
    if (keepCost.isZero() && !retireCost.isZero()) return round2(retireCost);
    if (!keepCost.isZero() && retireCost.isZero()) return round2(keepCost);
    if (keepCost.isZero() && retireCost.isZero()) return round2(keepCost);
    // Both non-zero → weighted average by qty. If both quantities are
    // 0 (nothing on hand either side, but historical rows exist),
    // pick keep's cost — it's the row that survives.
    const totalQty = new Prisma.Decimal(keepQty).plus(retireQty);
    if (totalQty.isZero()) return round2(keepCost);
    const totalCost = new Prisma.Decimal(keepQty)
        .times(keepCost)
        .plus(new Prisma.Decimal(retireQty).times(retireCost));
    return round2(totalCost.dividedBy(totalQty));
}

async function fkCountsForPart(partId: string): Promise<FkCounts> {
    const [jobPart, partRequest, estimateLine, purchaseOrderLine, partMovement] =
        await Promise.all([
            prisma.jobPart.count({ where: { partId } }),
            prisma.partRequest.count({ where: { partId } }),
            prisma.estimateLine.count({ where: { partId } }),
            prisma.purchaseOrderLine.count({ where: { partId } }),
            prisma.partMovement.count({ where: { partId } }),
        ]);
    return { jobPart, partRequest, estimateLine, purchaseOrderLine, partMovement };
}

for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const label = `pair #${i + 1} (garage ${pair.garageId.slice(0, 10)}…, keep ${pair.keepPartId.slice(0, 10)}…, retire ${pair.retirePartId.slice(0, 10)}…)`;
    console.log(`▶ ${label}${pair.note ? ` — ${pair.note}` : ""}`);

    try {
        // Load both Parts. Verify they're in the claimed garage. A
        // mismatched garageId is a caller bug, not a data problem —
        // fail this pair, continue the run.
        const keep = await prisma.part.findFirst({
            where: { id: pair.keepPartId, garageId: pair.garageId },
            select: { id: true, sku: true, name: true, cost: true, qtyOnHand: true, active: true, autoCreatedFromLineId: true },
        });
        const retire = await prisma.part.findFirst({
            where: { id: pair.retirePartId, garageId: pair.garageId },
            select: { id: true, sku: true, name: true, cost: true, qtyOnHand: true, active: true, autoCreatedFromLineId: true },
        });
        if (!keep) { outcomes.push({ pairIndex: i, ok: false, message: `keep ${pair.keepPartId} not found in garage ${pair.garageId}` }); console.log(`  ✗ keep not found in this garage — skipping`); continue; }
        if (!retire) { outcomes.push({ pairIndex: i, ok: false, message: `retire ${pair.retirePartId} not found in garage ${pair.garageId}` }); console.log(`  ✗ retire not found in this garage — skipping`); continue; }

        const fk = await fkCountsForPart(retire.id);
        const totalFks = fk.jobPart + fk.partRequest + fk.estimateLine + fk.purchaseOrderLine + fk.partMovement;
        const newKeepQty = keep.qtyOnHand + retire.qtyOnHand;
        const newKeepCost = blendMergeCost(keep.cost, keep.qtyOnHand, retire.cost, retire.qtyOnHand);

        console.log(`  keep:   sku=${keep.sku.padEnd(20)} name="${keep.name}" cost=${keep.cost.toFixed(2)} qty=${keep.qtyOnHand} active=${keep.active}`);
        console.log(`  retire: sku=${retire.sku.padEnd(20)} name="${retire.name}" cost=${retire.cost.toFixed(2)} qty=${retire.qtyOnHand} active=${retire.active}`);
        console.log(`  FKs pointing at retire: ${totalFks} total`);
        console.log(`    JobPart=${fk.jobPart}  PartRequest=${fk.partRequest}  EstimateLine=${fk.estimateLine}  PurchaseOrderLine=${fk.purchaseOrderLine}  PartMovement=${fk.partMovement}`);
        console.log(`  after: keep.qty ${keep.qtyOnHand} + ${retire.qtyOnHand} = ${newKeepQty}, keep.cost ${keep.cost.toFixed(2)} → ${newKeepCost.toFixed(2)}`);
        console.log(`         retire.qty → 0, retire.active → false${retire.autoCreatedFromLineId && !keep.autoCreatedFromLineId ? ", retire.autoCreatedFromLineId → null" : ""}`);

        if (!doCommit) {
            outcomes.push({
                pairIndex: i, ok: true,
                message: "dry-run",
                fkBefore: fk,
                stockBefore: { keep: keep.qtyOnHand, retire: retire.qtyOnHand },
                stockAfter: { keep: newKeepQty, retire: 0 },
                costBefore: { keep: keep.cost.toFixed(2), retire: retire.cost.toFixed(2) },
                costAfter: { keep: newKeepCost.toFixed(2) },
            });
            console.log(`  ✓ would apply`);
            continue;
        }

        // COMMIT PATH — one transaction, all updates or nothing.
        // Order: null out retire's autoCreatedFromLineId first (if it
        // would collide with keeper's); then repoint every FK; then
        // roll stock + cost + retire flag. That order keeps the DB
        // in a valid state at every intermediate write.
        await prisma.$transaction(async (tx) => {
            if (retire.autoCreatedFromLineId && !keep.autoCreatedFromLineId) {
                // Keep row will adopt the FK — first null out retire's,
                // then set keep's, so the @unique constraint never
                // sees two rows both holding the same id.
                const fkId = retire.autoCreatedFromLineId;
                await tx.part.update({ where: { id: retire.id }, data: { autoCreatedFromLineId: null } });
                await tx.part.update({ where: { id: keep.id }, data: { autoCreatedFromLineId: fkId } });
            } else if (retire.autoCreatedFromLineId) {
                // Both would have one — retire's is redundant, null it
                // without moving it (keeper's audit lineage wins).
                await tx.part.update({ where: { id: retire.id }, data: { autoCreatedFromLineId: null } });
            }

            // Repoint every FK that references the retiring Part.
            // InvoiceLine intentionally NOT in this list — it holds a
            // frozen snapshot (see the header comment).
            await tx.jobPart.updateMany({ where: { partId: retire.id }, data: { partId: keep.id } });
            await tx.partRequest.updateMany({ where: { partId: retire.id }, data: { partId: keep.id } });
            await tx.estimateLine.updateMany({ where: { partId: retire.id }, data: { partId: keep.id } });
            await tx.purchaseOrderLine.updateMany({ where: { partId: retire.id }, data: { partId: keep.id } });
            await tx.partMovement.updateMany({ where: { partId: retire.id }, data: { partId: keep.id } });

            await tx.part.update({
                where: { id: keep.id },
                data: { qtyOnHand: newKeepQty, cost: newKeepCost },
            });
            await tx.part.update({
                where: { id: retire.id },
                data: { qtyOnHand: 0, active: false },
            });
        });

        outcomes.push({
            pairIndex: i, ok: true,
            message: "committed",
            fkBefore: fk,
            stockBefore: { keep: keep.qtyOnHand, retire: retire.qtyOnHand },
            stockAfter: { keep: newKeepQty, retire: 0 },
            costBefore: { keep: keep.cost.toFixed(2), retire: retire.cost.toFixed(2) },
            costAfter: { keep: newKeepCost.toFixed(2) },
        });
        console.log(`  ✓ committed`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outcomes.push({ pairIndex: i, ok: false, message: msg });
        console.log(`  ✗ error — pair rolled back: ${msg}`);
    }
    console.log("");
}

// ── Summary ────────────────────────────────────────────────────────

const ok = outcomes.filter((o) => o.ok).length;
const fail = outcomes.filter((o) => !o.ok).length;
console.log("=== summary ===");
console.log(`  pairs: ${pairs.length}   ok: ${ok}   failed: ${fail}   mode: ${doCommit ? "COMMIT" : "DRY-RUN"}`);
if (fail > 0) {
    for (const o of outcomes.filter((x) => !x.ok)) {
        console.log(`  pair #${o.pairIndex + 1}: ${o.message}`);
    }
    process.exit(1);
}
await prisma.$disconnect();
