import "./lib/target-prod.mjs";

// Local-only diagnostic. Finds which unique constraint blocks the
// `via=moulkia` intake POST for plate D 12345 / Mohammed Al Maktoum.
// Reports only — does not delete.
async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const garageId = "demo-garage";

  const vehicle = await prisma.vehicle.findFirst({
    where: { plate: "D 12345", customer: { garageId } },
    include: { customer: true },
  });
  const customer = await prisma.customer.findFirst({
    where: {
      garageId,
      OR: [
        { name: { contains: "Mohammed Al Maktoum" } },
        { name: { contains: "Al Maktoum" } },
      ],
    },
  });
  const highestJob = await prisma.jobCard.aggregate({
    where: { garageId },
    _max: { number: true },
  });

  console.log(
    JSON.stringify(
      {
        vehiclePlate_D12345: vehicle,
        customer_AlMaktoum: customer,
        jobCard_maxNumber: highestJob._max.number,
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
