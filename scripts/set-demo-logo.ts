import "./lib/target-prod.mjs";

// LOCAL-ONLY test fixture. Points the demo garage's logoUrl at the
// hand-crafted SVG in `.uploads/logo-demo-real.svg` so AR can click-
// verify the REAL logo path on the printable + customer-facing docs,
// rather than the GarageOS fallback that renders when logoUrl is null.
//
// Restore with:
//   UPDATE "Garage" SET "logoUrl" = NULL WHERE id = 'demo-garage';
async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const before = await prisma.garage.findUnique({
    where: { id: "demo-garage" },
    select: { logoUrl: true },
  });
  const after = await prisma.garage.update({
    where: { id: "demo-garage" },
    data: { logoUrl: "/api/files/logo-demo-real.png" },
    select: { logoUrl: true },
  });
  console.log(
    JSON.stringify(
      {
        note: "Demo garage logoUrl set for local click-verify.",
        logoUrl_before: before?.logoUrl ?? null,
        logoUrl_after: after.logoUrl,
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
