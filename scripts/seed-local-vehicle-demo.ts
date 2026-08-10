import "./lib/target-local.mjs";
import { prisma } from "@/lib/prisma";

async function main() {
  const owner = await prisma.user.findFirst({ where: { email: "owner@demo.garage" } });
  if (!owner) throw new Error("owner@demo.garage not found — run npm run db:seed first");
  const gid = owner.garageId;

  const supplierName = "Al Futtaim Auto Parts";
  let s = await prisma.supplier.findFirst({ where: { garageId: gid, name: supplierName } });
  if (!s)
    s = await prisma.supplier.create({
      data: {
        garageId: gid,
        name: supplierName,
        contactPerson: "Sara",
        phone: "+971 4 555 1000",
        email: "parts@af.ae",
        active: true,
      },
    });

  const custPhone = "+971555000001";
  let c = await prisma.customer.findFirst({ where: { garageId: gid, phone: custPhone } });
  if (!c) c = await prisma.customer.create({ data: { garageId: gid, name: "Ahmed Al-Falah", phone: custPhone } });

  const seed = [
    { plate: "DXB-A-12345", make: "Toyota", model: "Land Cruiser", year: 2021, engineSize: "4.0L V6", fuelType: "PETROL", vin: "JT111ABC0000001" },
    { plate: "DXB-B-54321", make: "Nissan", model: "Patrol", year: 2019, engineSize: "5.6L V8", fuelType: "PETROL", vin: "JN222XYZ0000002" },
    { plate: "AUH-C-77777", make: "Ford", model: "Focus", year: 2014, engineSize: "1.6L", fuelType: "PETROL", vin: "WF0BB2KF1ELY11017" },
  ];
  for (const v of seed) {
    const exists = await prisma.vehicle.findFirst({ where: { customerId: c.id, plate: v.plate } });
    if (!exists) await prisma.vehicle.create({ data: { customerId: c.id, ...v } });
  }
  console.log({ garage: gid, supplier: s.id, vehicles: seed.length });
}
main().finally(() => prisma.$disconnect());
