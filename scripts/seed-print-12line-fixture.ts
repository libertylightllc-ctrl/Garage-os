import "./lib/target-local.mjs";

// 12-line-complaint fixture — matches the shape of the real JC-2026-0078
// job AR flagged as overflowing to page 2 by just the signature block.
// Used to verify the print-tighten reclaims enough vertical space to
// fit a 12-line complaint on one A4 page.

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { nextJobNumber } = await import("./lib/next-job-number");
  const garageId = "demo-garage";

  const vehicle = await prisma.vehicle.findFirst({
    where: { customer: { garageId } },
    include: { customer: true },
  });
  if (!vehicle) throw new Error("Seed the DB first — no vehicle found");

  const FIXTURE_ID = "print-12line-2026-07-24";
  let job = await prisma.jobCard.findFirst({
    where: { garageId, id: FIXTURE_ID },
    include: { vehicle: { include: { customer: true } } },
  });

  // 12 discrete lines: each ~one sentence, ~80 chars, matches how a
  // customer with multiple complaints actually writes.
  const complaint = [
    "AC not cooling on the driver side; passenger side is fine.",
    "Engine rattle on cold start, quiets when warmed up.",
    "Brake pedal feels soft after long highway drives.",
    "Steering wheel vibrates at speeds over 100 km/h.",
    "Rear passenger window sticks about 2cm from the top.",
    "Battery needed jump-starting twice last week.",
    "Occasional dashboard warning light — customer cannot photograph it.",
    "Please check tyre pressures and top up all fluids.",
    "Also asked us to rotate the tyres if within service window.",
    "Slight fuel smell reported after refuelling — investigate.",
    "Interior fan makes a click at position 3 on the speed dial.",
    "Rear windscreen wiper leaves a streak on the lower left arc.",
  ].join("\n");

  if (!job) {
    // Same jobSeq mechanism as the real intake action — see
    // scripts/lib/next-job-number.ts for why MAX(number)+1 is wrong.
    const nextNumber = await nextJobNumber(prisma, garageId);

    job = await prisma.jobCard.create({
      data: {
        id: FIXTURE_ID,
        garageId,
        vehicleId: vehicle.id,
        createdAt: new Date("2026-07-24T09:15:00+04:00"),
        status: "ARRIVED",
        number: nextNumber,
        complaint,
        mileageIn: 82_450,
        fuelLevel: "HALF",
        exteriorCondition: ["SCRATCHES", "DENTS"],
        exteriorRemarks:
          "Small scratch on left rear door and one on right front fender.",
        interiorCondition: ["DIRTY"],
        valuables: ["MOBILE_CHARGER"],
        moulkiaConsentAt: new Date("2026-07-24T09:14:00+04:00"),
      },
      include: { vehicle: { include: { customer: true } } },
    });
  } else {
    // Ensure the complaint is 12 lines if the fixture already exists
    // (in case an older run had a shorter one).
    await prisma.jobCard.update({
      where: { id: FIXTURE_ID },
      data: { complaint },
    });
  }

  console.log(
    JSON.stringify(
      {
        id: job.id,
        number: job.number,
        complaintLines: (job.complaint ?? "").split("\n").length,
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
