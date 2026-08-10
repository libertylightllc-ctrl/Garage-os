// READ-ONLY diagnostic. Loads .env only (NOT .env.local) so it hits PROD.
// Reports estimate line details for a given (jobNumber, year) so we can
// see exactly how many kind=PART lines have partId set. Zero writes.
//
// Usage:
//   npx tsx scripts/check-estimate-lines-prod.ts 77
//   npx tsx scripts/check-estimate-lines-prod.ts 77 2026
import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";

const targetNumber = Number(process.argv[2] ?? "77");
const targetYear = Number(process.argv[3] ?? "2026");
const also = Number(process.argv[4] ?? "1");

async function main() {
  if (!process.env.DATABASE_URL?.includes("supabase")) {
    console.error("Refusing to run — DATABASE_URL doesn't look like prod (no 'supabase' in host). Rename .env.local or unset it.");
    process.exit(1);
  }
  console.log(`Target: PROD (${new URL(process.env.DATABASE_URL!).host})`);
  for (const jobNumber of [targetNumber, also]) {
    const jobs = await prisma.jobCard.findMany({
      where: {
        number: jobNumber,
        createdAt: { gte: new Date(`${targetYear}-01-01`), lt: new Date(`${targetYear + 1}-01-01`) },
      },
      include: {
        garage: { select: { id: true, name: true } },
        vehicle: { select: { plate: true, make: true, model: true } },
        estimates: {
          include: {
            lines: { select: { id: true, kind: true, description: true, partId: true, declined: true }, orderBy: { createdAt: "asc" } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    for (const j of jobs) {
      const jcNo = `JC-${targetYear}-${String(jobNumber).padStart(4, "0")}`;
      console.log(`\n=== ${jcNo} (garage: ${j.garage.name}) — ${j.vehicle.make} ${j.vehicle.model} · ${j.vehicle.plate} ===`);
      for (const est of j.estimates) {
        const parts = est.lines.filter((l) => l.kind === "PART");
        const partsWithId = parts.filter((l) => l.partId !== null);
        const partsWithoutId = parts.filter((l) => l.partId === null);
        console.log(`  Estimate ${est.id.slice(-6)} status=${est.status} · ${est.lines.length} total lines · ${parts.length} PART · ${partsWithId.length} with partId · ${partsWithoutId.length} free-text`);
        for (const l of est.lines) {
          const tag = l.kind === "PART" ? (l.partId ? "PART+id" : "PART-free") : l.kind;
          const dec = l.declined ? " [DECLINED]" : "";
          console.log(`    - ${tag.padEnd(9)} ${l.description}${dec}`);
        }
      }
    }
    if (jobs.length === 0) {
      console.log(`\n=== JC-${targetYear}-${String(jobNumber).padStart(4, "0")} — NOT FOUND ===`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
