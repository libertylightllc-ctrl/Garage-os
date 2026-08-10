import "./lib/target-local.mjs";

// 30-line-complaint fixture — deliberately over the ~14-line cutoff so
// the print form MUST overflow to page 2. Used to verify the @page
// margin-box repeating header still renders correctly after the
// worst-case-Chrome tighten (71be465): page 1 blank via @page :first,
// page 2 shows "JC-… · plate · Page 2 of N" at 11pt semibold #111827.
//
// Complaint is 30 discrete customer-voice sentences at ~80 chars each,
// which under leading-snug + A4 print width renders as 30+ visual
// lines and puts the signature block firmly on page 2.
//
// Number allocation uses the shared helper (per AGENTS.md rule) so
// running this cannot desync Garage.jobSeq from JobCard.number.

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { nextJobNumber } = await import("./lib/next-job-number");
  const garageId = "demo-garage";

  const vehicle = await prisma.vehicle.findFirst({
    where: { customer: { garageId } },
    include: { customer: true },
  });
  if (!vehicle) throw new Error("Seed the DB first — no vehicle found");

  const FIXTURE_ID = "print-30line-2026-07-24";
  let job = await prisma.jobCard.findFirst({
    where: { garageId, id: FIXTURE_ID },
    include: { vehicle: { include: { customer: true } } },
  });

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
    "Front left headlight seems dimmer than the right — bulb check.",
    "Suspension knock over speed bumps at low speeds.",
    "Auto-hold brake occasionally releases without pedal press.",
    "Reverse camera image flickers when reversing in bright sun.",
    "Bluetooth phone disconnects after 20 minutes of driving.",
    "Trunk latch requires two attempts to close properly.",
    "Fuel gauge reads full for the first 100km after fill-up.",
    "Cruise control disengages when going uphill on M-mode.",
    "Sunroof close switch needs firm press — motor may be tired.",
    "Passenger seat memory position 2 does not restore correctly.",
    "Windshield washers spray unevenly on the driver side.",
    "Interior LED under the rear-view mirror flickers at night.",
    "Slight coolant smell inside the cabin on cold mornings.",
    "Front right tyre wears faster than the others — alignment.",
    "Anti-glare rear-view mirror stuck in glare mode.",
    "Owner also requests new wiper blades all round.",
    "Ideal delivery time: end of day Thursday if possible.",
    "Customer prefers WhatsApp updates over phone calls.",
  ].join("\n");

  if (!job) {
    const nextNumber = await nextJobNumber(prisma, garageId);
    job = await prisma.jobCard.create({
      data: {
        id: FIXTURE_ID,
        garageId,
        vehicleId: vehicle.id,
        createdAt: new Date("2026-07-24T14:30:00+04:00"),
        status: "ARRIVED",
        number: nextNumber,
        complaint,
        mileageIn: 82_450,
        fuelLevel: "HALF",
        exteriorCondition: ["SCRATCHES", "DENTS"],
        exteriorRemarks:
          "Multiple small scratches around the wheel arches, one dent on the driver-side rear door.",
        interiorCondition: ["DIRTY", "WARNING_LIGHT"],
        interiorRemarks:
          "Cabin dust film; check-engine light lit at intake.",
        valuables: ["DOCUMENTS", "MOBILE_CHARGER"],
        valuablesNote: "Registration in glovebox; USB-C fast charger cable.",
        moulkiaConsentAt: new Date("2026-07-24T14:29:00+04:00"),
      },
      include: { vehicle: { include: { customer: true } } },
    });
  } else {
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
        complaintChars: (job.complaint ?? "").length,
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
