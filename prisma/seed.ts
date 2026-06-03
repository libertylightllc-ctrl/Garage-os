import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient, Role, Lang } from "../src/generated/prisma/client";
import { makePgAdapter } from "../src/lib/pg-adapter";

const prisma = new PrismaClient({ adapter: makePgAdapter() });

const GARAGE_ID = "demo-garage";

async function main() {
  const garage = await prisma.garage.upsert({
    where: { id: GARAGE_ID },
    update: { name: "Demo Garage (UAE)" },
    create: {
      id: GARAGE_ID,
      name: "Demo Garage (UAE)",
      country: "UAE",
      trn: "100000000000003",
    },
  });

  const passwordHash = await bcrypt.hash("password", 10);
  const staff = [
    { email: "owner@demo.garage", name: "Omar Owner", role: Role.OWNER },
    { email: "advisor@demo.garage", name: "Aisha Advisor", role: Role.ADVISOR },
    { email: "tech@demo.garage", name: "Tariq Tech", role: Role.TECH },
    { email: "accountant@demo.garage", name: "Aliya Accountant", role: Role.ACCOUNTANT },
  ];

  for (const s of staff) {
    await prisma.user.upsert({
      where: { email: s.email },
      update: { name: s.name, role: s.role, passwordHash, garageId: garage.id },
      create: {
        email: s.email,
        name: s.name,
        role: s.role,
        passwordHash,
        garageId: garage.id,
        lang: Lang.en,
      },
    });
  }

  // Sample customers (passwordless) + one vehicle, for later build steps.
  const khalid = await prisma.customer.upsert({
    where: { garageId_phone: { garageId: garage.id, phone: "+971500000001" } },
    update: {},
    create: { garageId: garage.id, name: "Khalid Customer", phone: "+971500000001", lang: Lang.ar },
  });
  await prisma.customer.upsert({
    where: { garageId_phone: { garageId: garage.id, phone: "+971500000002" } },
    update: {},
    create: { garageId: garage.id, name: "Mariam Customer", phone: "+971500000002", lang: Lang.ar },
  });

  const hasVehicle = await prisma.vehicle.findFirst({ where: { customerId: khalid.id } });
  if (!hasVehicle) {
    await prisma.vehicle.create({
      data: {
        customerId: khalid.id,
        make: "Toyota",
        model: "Land Cruiser",
        year: 2021,
        plate: "A 12345",
        vin: "JTMHV05J104000000",
      },
    });
  }

  // Sample parts (for the technician "Request Part" flow + later inventory).
  const parts = [
    { sku: "OIL-5W30", name: "Engine Oil 5W-30 (1L)", cost: 18, price: 35, qtyOnHand: 40 },
    { sku: "FLT-AIR", name: "Air Filter", cost: 25, price: 60, qtyOnHand: 15 },
    { sku: "BRK-PAD-F", name: "Front Brake Pads", cost: 90, price: 180, qtyOnHand: 8 },
    { sku: "BAT-70AH", name: "Battery 70Ah", cost: 220, price: 380, qtyOnHand: 6 },
  ];
  for (const p of parts) {
    await prisma.part.upsert({
      where: { garageId_sku: { garageId: garage.id, sku: p.sku } },
      update: {},
      create: { garageId: garage.id, ...p },
    });
  }

  // Subscription plans (prices live in the DB; map stripePriceId per env when wiring Stripe).
  const plans = [
    { code: "STARTER", name: "Starter", priceMonthly: 299 },
    { code: "GROWTH", name: "Growth", priceMonthly: 599 },
    { code: "PRO", name: "Pro", priceMonthly: 1499 },
  ];
  for (const p of plans) {
    await prisma.plan.upsert({
      where: { code: p.code },
      update: { name: p.name, priceMonthly: p.priceMonthly },
      create: { code: p.code, name: p.name, priceMonthly: p.priceMonthly, currency: "AED" },
    });
  }

  console.log("Seed complete: 1 garage, 4 staff, 2 customers, 1 vehicle, 4 parts, 3 plans.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
