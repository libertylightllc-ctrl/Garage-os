import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
const envLocal = path.resolve(".env.local");
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal, override: true });
} else {
  dotenv.config();
}

async function main() {
  const { prisma } = await import("../src/lib/prisma");
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
    const highest = await prisma.jobCard.aggregate({
      where: { garageId },
      _max: { number: true },
    });
    const nextNumber = (highest._max.number ?? 0) + 1;

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
