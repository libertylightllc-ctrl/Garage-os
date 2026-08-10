import "./lib/target-prod.mjs";

// LOCAL-ONLY unblock — non-destructive.
// Rename the leftover Vehicle plate + Customer phone so the intake
// POST's unique-constraint checks don't fire, then restore them
// afterward if AR wants. Preserves every JobCard / Estimate / Invoice
// hanging off the vehicle — no downstream cascade needed.
//
// Original:
//   Vehicle.plate  = "D 12345"
//   Customer.phone = "0509633330"
// Sidelined to:
//   Vehicle.plate  = "D 12345-SIDELINED"
//   Customer.phone = "0509633330-SIDELINED"
async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const garageId = "demo-garage";

  const vehicle = await prisma.vehicle.findFirst({
    where: { plate: "D 12345", customer: { garageId } },
    include: { customer: true },
  });
  if (!vehicle) {
    console.log("Nothing to clear — no Vehicle with plate 'D 12345'.");
    return;
  }

  await prisma.$transaction([
    prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { plate: "D 12345-SIDELINED" },
    }),
    prisma.customer.update({
      where: { id: vehicle.customer.id },
      data: { phone: `${vehicle.customer.phone}-SIDELINED` },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        note: "Non-destructive sideline. Original rows kept, uniques freed.",
        vehicleId: vehicle.id,
        customerId: vehicle.customer.id,
        plateBefore: "D 12345",
        plateAfter: "D 12345-SIDELINED",
        phoneBefore: vehicle.customer.phone,
        phoneAfter: `${vehicle.customer.phone}-SIDELINED`,
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
