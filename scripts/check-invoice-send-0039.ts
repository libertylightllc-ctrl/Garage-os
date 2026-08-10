// READ-ONLY. Ran against Prod (DATABASE_URL set inline by the operator
// running this — pulled from Vercel via `vercel env pull`). Zero writes.
// Reports every InvoiceSend row for INV-2026-0039 with sender + channel +
// timestamps so we can tell whether the send was hand-fired from a local
// dev instance vs a Vercel Prod deploy.
import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";

const INV_ID = "cmskqh9pd000b04jskvkbmyqv";

async function main() {
  const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "(none)";
  if (!host.includes("supabase")) {
    console.error(`Refusing to run — DATABASE_URL host is ${host}, no 'supabase'.`);
    process.exit(1);
  }
  console.log(`Target: PROD (${host})\n`);

  const inv = await prisma.invoice.findUnique({
    where: { id: INV_ID },
    select: {
      id: true, number: true, issuedAt: true, status: true,
      garage: { select: { name: true } },
      jobCard: {
        select: {
          invoiceSentAt: true,
          invoiceDeliveredAt: true,
          vehicle: {
            select: { plate: true, make: true, model: true, customer: { select: { name: true, phone: true } } },
          },
        },
      },
    },
  });
  console.log("--- Invoice ---");
  console.log(JSON.stringify(inv, null, 2));

  const sends = await prisma.invoiceSend.findMany({
    where: { invoiceId: INV_ID },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, channel: true, recipient: true, status: true,
      sentByName: true, sentByUserId: true, createdAt: true,
      providerMessageId: true, errorCode: true,
    },
  });
  console.log(`\n--- InvoiceSend rows (${sends.length}) ---`);
  for (const s of sends) {
    console.log(JSON.stringify(s, null, 2));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
