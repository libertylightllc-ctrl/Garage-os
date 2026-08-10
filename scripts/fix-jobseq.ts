import "./lib/target-prod.mjs";

// LOCAL-ONLY. Sync Garage.jobSeq up to MAX(JobCard.number) for
// demo-garage. My header-sweep and print-tighten fixture scripts
// (seed-print-*-fixture.ts) inserted JobCards with hardcoded `number`
// values without bumping jobSeq — so the intake action's atomic
// allocator picks a value that's already used, and Prisma throws
// UniqueConstraintViolation on @@unique([garageId, number]).
//
// Non-destructive: only writes if jobSeq < max(number). Idempotent.
async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const garageId = "demo-garage";

  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { jobSeq: true },
  });
  const highest = await prisma.jobCard.aggregate({
    where: { garageId },
    _max: { number: true },
  });
  const before = garage?.jobSeq ?? 0;
  const maxNumber = highest._max.number ?? 0;

  if (before >= maxNumber) {
    console.log(
      `No sync needed. jobSeq=${before} >= max(number)=${maxNumber}.`,
    );
    return;
  }

  await prisma.garage.update({
    where: { id: garageId },
    data: { jobSeq: maxNumber },
  });

  console.log(
    JSON.stringify(
      {
        note: "Bumped jobSeq to match highest JobCard.number so intake allocator lands on maxNumber+1 next.",
        garageId,
        jobSeq_before: before,
        jobSeq_after: maxNumber,
        max_JobCard_number: maxNumber,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
