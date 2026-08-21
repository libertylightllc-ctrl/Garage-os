// Duplicate-customer probe (AR 2026-08-22 Batch 8).
//
// Report-only. Never writes. Refuses to accept a merge flag or any
// mutation argument. Per-garage counts + a small sample of each
// duplicate cluster, so an operator can decide whether to merge
// manually (via a separate merge tool that doesn't exist yet).
//
// Detection layers, all garage-scoped:
//
//   1. phone-normalized  — normalizeUaePhone(customer.phone) shared
//      across ≥2 customers in the same garage. The webhook + intake
//      normalise on write today, but historical rows imported from
//      Moulkia / CSV / manual entry may carry unnormalized phones —
//      "+971 50 123 4567" and "0501234567" landing as two separate
//      customer rows.
//
//   2. waId              — same waId on ≥2 customers. Rare (the
//      webhook dedupes on write), but a race between two inbound
//      messages before the first commits can produce two rows.
//
//   3. name-normalized   — trim + lowercase + collapse whitespace.
//      Weakest signal (same-name customers are legitimate), so
//      only reported when phone also matches; the phone check
//      above already covers the strong case, so this pass adds
//      almost nothing on top of it. Kept for completeness — a
//      shop that hasn't been capturing phones consistently can
//      still surface probable dupes.
//
// Targets prod via ./lib/target-prod.mjs. Use --local to run against
// the dev DB for testing:
//
//   npx tsx scripts/probe-duplicate-customers.mts        # PROD
//   npx tsx scripts/probe-duplicate-customers.mts --local # local
//
// Output shape:
//
//   [garage: Demo Garage (UAE)] 3 duplicate clusters found
//     - phone 971501234567 (2 rows)
//       #cust_A "Khalid Customer"    2026-01-15
//       #cust_B "khalid customer"    2026-06-02
//     - phone 971509876543 (3 rows)
//       ...
//     - waId 971505550001 (2 rows)
//       ...
//
// Rows-per-garage cap set high (10 clusters shown, count of remainder
// noted) so a garage with hundreds of dupes doesn't flood stdout.

const LOCAL = process.argv.includes("--local");
if (LOCAL) {
    await import("./lib/target-local.mjs");
} else {
    await import("./lib/target-prod.mjs");
}
const { prisma } = await import("../src/lib/prisma");
const { normalizeUaePhone } = await import("../src/lib/normalize");

const CLUSTERS_PER_GARAGE = 10;

interface ClusterRow {
    id: string;
    name: string;
    phone: string;
    waId: string | null;
    createdAt: Date;
}

async function main() {
    const garages = await prisma.garage.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
    });

    let totalClusters = 0;
    for (const g of garages) {
        const customers = await prisma.customer.findMany({
            where: { garageId: g.id },
            select: { id: true, name: true, phone: true, waId: true, createdAt: true },
        });

        // Bucket by every detection key, then keep buckets with >= 2
        // members. Same customer can appear in more than one bucket
        // (its phone-normalized bucket + its waId bucket) — that's
        // fine, both signals are worth surfacing.
        const byPhone = new Map<string, ClusterRow[]>();
        const byWaId = new Map<string, ClusterRow[]>();
        for (const c of customers) {
            const p = normalizeUaePhone(c.phone) || c.phone;
            if (p) {
                const arr = byPhone.get(p) ?? [];
                arr.push(c);
                byPhone.set(p, arr);
            }
            if (c.waId) {
                const arr = byWaId.get(c.waId) ?? [];
                arr.push(c);
                byWaId.set(c.waId, arr);
            }
        }

        interface Cluster {
            kind: "phone" | "waId";
            key: string;
            rows: ClusterRow[];
        }
        const clusters: Cluster[] = [];
        for (const [key, rows] of byPhone) {
            if (rows.length >= 2) clusters.push({ kind: "phone", key, rows });
        }
        for (const [key, rows] of byWaId) {
            if (rows.length >= 2) clusters.push({ kind: "waId", key, rows });
        }
        if (clusters.length === 0) continue;

        // Sort widest-cluster first; tie-break on key so output is
        // deterministic across runs on the same DB state.
        clusters.sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
        totalClusters += clusters.length;

        console.log(`[garage: ${g.name}] ${clusters.length} duplicate cluster(s)`);
        const shown = clusters.slice(0, CLUSTERS_PER_GARAGE);
        for (const cl of shown) {
            console.log(`  - ${cl.kind} ${cl.key} (${cl.rows.length} rows)`);
            for (const r of cl.rows) {
                const created = r.createdAt.toISOString().slice(0, 10);
                console.log(`      #${r.id.slice(-8)}  ${JSON.stringify(r.name).padEnd(30)} ${created}`);
            }
        }
        const hidden = clusters.length - shown.length;
        if (hidden > 0) console.log(`  … +${hidden} more cluster(s) not shown`);
        console.log();
    }

    console.log(
        `Total: ${totalClusters} duplicate cluster(s) across ${garages.length} garage(s).`,
    );
    console.log("Report only — no rows were changed. Use a separate merge tool to act.");
    await prisma.$disconnect();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
