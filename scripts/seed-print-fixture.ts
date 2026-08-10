import "./lib/target-local.mjs";

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { nextJobNumber } = await import("./lib/next-job-number");
  const garageId = "demo-garage";

  const vehicle = await prisma.vehicle.findFirst({
    where: { customer: { garageId } },
    include: { customer: true },
  });
  if (!vehicle) throw new Error("Seed the DB first — no vehicle found");

  await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: { engineSize: "4.0L", fuelType: "PETROL" },
  });

  // Find or create a print-verify job. We look up by our stable id first
  // so re-running this script is idempotent; if it doesn't exist we grab
  // an unused number to sidestep the (garageId, number) unique constraint.
  const FIXTURE_ID = "print-verify-2026-07-23";
  let job = await prisma.jobCard.findFirst({
    where: { garageId, id: FIXTURE_ID },
    include: { vehicle: { include: { customer: true } } },
  });

  if (!job) {
    // Allocate the JC number the SAME way the real intake action does:
    // increment Garage.jobSeq and use its returned value. Any hand-
    // rolled MAX(number)+1 desyncs jobSeq from actual max and breaks
    // the next intake POST. See scripts/lib/next-job-number.ts.
    const nextNumber = await nextJobNumber(prisma, garageId);

    job = await prisma.jobCard.create({
      data: {
        id: FIXTURE_ID,
        garageId,
        vehicleId: vehicle.id,
        createdAt: new Date("2026-07-23T07:29:00+04:00"),
        status: "ARRIVED",
        number: nextNumber,
        complaint:
          "AC not cooling — engine also makes a light rattle on cold start.",
        mileageIn: 82_450,
        fuelLevel: "HALF",
        exteriorCondition: ["SCRATCHES", "DENTS"],
        exteriorRemarks:
          "Small scratch on left rear door, visible from 1 m.",
        interiorCondition: ["DIRTY"],
        valuables: ["MOBILE_CHARGER"],
        moulkiaConsentAt: new Date("2026-07-23T07:28:00+04:00"),
      },
      include: { vehicle: { include: { customer: true } } },
    });
  }

  console.log(
    JSON.stringify(
      {
        id: job.id,
        number: job.number,
        createdAt: job.createdAt,
        vehicle: {
          make: job.vehicle.make,
          model: job.vehicle.model,
          year: job.vehicle.year,
          plate: job.vehicle.plate,
        },
        customer: job.vehicle.customer.name,
        url: `http://localhost:3000/advisor/jobs/${job.id}/print`,
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
