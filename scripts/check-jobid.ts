import "./lib/target-prod.mjs";

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const job = await prisma.jobCard.findUnique({
    where: { id: "cmryswf6b000j1ouwtez8zabn" },
    select: { id: true, number: true, createdAt: true, status: true, vehicle: { select: { plate: true, make: true, model: true } } },
  });
  console.log(JSON.stringify(job, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
