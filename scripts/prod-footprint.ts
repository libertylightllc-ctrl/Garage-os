// READ-ONLY. Enumerates every Garage in Prod with a real-world usage
// footprint: is it a pilot, when created, how many customers/vehicles/
// jobs/invoices/staff. Meant to answer "which of these are actually
// operating vs demo/test tenants?" Zero writes.
import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";

async function main() {
  const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "(none)";
  if (!host.includes("supabase")) {
    console.error(`Refusing to run — DATABASE_URL host is ${host}, no 'supabase'.`);
    process.exit(1);
  }
  console.log(`Target: PROD (${host})\n`);

  const garages = await prisma.garage.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true, name: true, country: true, trn: true,
      isPilot: true, createdAt: true, invoiceSeq: true, jobSeq: true,
      _count: {
        select: {
          users: true, customers: true, jobCards: true, invoices: true,
          bookings: true, purchaseOrders: true,
        },
      },
    },
  });

  console.log(`Total garages in Prod: ${garages.length}\n`);
  for (const g of garages) {
    console.log(`── ${g.name}`);
    console.log(`   id         : ${g.id}`);
    console.log(`   country    : ${g.country}${g.trn ? ` · TRN ${g.trn}` : ""}`);
    console.log(`   isPilot    : ${g.isPilot}`);
    console.log(`   createdAt  : ${g.createdAt.toISOString()}`);
    console.log(`   invoiceSeq : ${g.invoiceSeq}`);
    console.log(`   jobSeq     : ${g.jobSeq}`);
    console.log(`   users      : ${g._count.users}`);
    console.log(`   customers  : ${g._count.customers}`);
    console.log(`   bookings   : ${g._count.bookings}`);
    console.log(`   jobCards   : ${g._count.jobCards}`);
    console.log(`   invoices   : ${g._count.invoices}`);
    console.log(`   POs        : ${g._count.purchaseOrders}`);
    console.log("");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
