import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
const envLocal = path.resolve(".env.local");
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal, override: true });
} else {
  dotenv.config();
}

// Long-complaint fixture — forces the print form to spill onto page 2 so
// the @page repeating-header strip actually shows up in print preview.
// Same vehicle + customer as the one-page fixture, different job id.

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const garageId = "demo-garage";

  const vehicle = await prisma.vehicle.findFirst({
    where: { customer: { garageId } },
    include: { customer: true },
  });
  if (!vehicle) throw new Error("Seed the DB first — no vehicle found");

  const FIXTURE_ID = "print-overflow-2026-07-23";
  let job = await prisma.jobCard.findFirst({
    where: { garageId, id: FIXTURE_ID },
    include: { vehicle: { include: { customer: true } } },
  });

  const bigComplaint = [
    "AC not cooling — engine also makes a light rattle on cold start,",
    "noise disappears when it warms up.",
    "Customer reports a soft brake pedal on the highway, especially",
    "after 30 minutes of continuous driving.",
    "Steering wheel vibrates at 100+ km/h; wheel alignment last done",
    "18 months ago per receipt from a different shop.",
    "Rear passenger window won't retract fully — sticks about 2cm from",
    "the top; motor sound is audible so likely a regulator/track issue.",
    "Battery had to be jump-started twice last week; customer suspects",
    "parasitic drain but cannot narrow it down.",
    "One warning light on dash that comes and goes — customer thinks",
    "it's the check-engine but couldn't photograph before it cleared.",
    "Also asked us to check tyre pressures and top up all fluids while",
    "the car is in.",
  ].join(" ");

  const bigRemarks = [
    "Front bumper: hairline scratch across the whole width, deepest on",
    "the right corner; several stone chips around the license plate.",
    "Left rear door: paint scuff near the handle, roughly 4cm wide.",
    "Roof: small dent above the driver door, visible only under",
    "raking light.",
  ].join(" ");

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
        createdAt: new Date("2026-07-23T08:15:00+04:00"),
        status: "ARRIVED",
        number: nextNumber,
        complaint: bigComplaint,
        mileageIn: 82_450,
        fuelLevel: "HALF",
        exteriorCondition: ["SCRATCHES", "DENTS"],
        exteriorRemarks: bigRemarks,
        interiorCondition: ["DIRTY", "WARNING_LIGHT"],
        interiorRemarks:
          "Passenger footwell mat visibly stained; dash 'check engine' light lit at intake.",
        valuables: ["DOCUMENTS", "MOBILE_CHARGER"],
        valuablesNote: "Vehicle registration in glovebox; USB-C charger.",
        moulkiaConsentAt: new Date("2026-07-23T08:14:00+04:00"),
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
        complaintLength: (job.complaint ?? "").length,
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
