// READ-ONLY. Loads .env only (NOT .env.local) so it hits PROD.
// Locates INV-2026-0039 by (number, year) AND by the cuid AR posted
// from the print footer. If it exists in prod → the signing bug is
// real. If it doesn't → the invoice was created on a Preview URL and
// the "not found" is expected (different AUTH_SECRET signed the link).
import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";
import { signId } from "../src/lib/tokens";

const TARGET_ID = "cmskqh9pd000b04jskvkbmyqv";
const TARGET_NUMBER = 39;
const TARGET_YEAR = 2026;

async function main() {
  const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "(none)";
  if (!host.includes("supabase")) {
    console.error(`Refusing to run — DATABASE_URL host is ${host}, no 'supabase'. Rename .env.local first.`);
    process.exit(1);
  }
  console.log(`Target: PROD (${host})\n`);

  // 1. By cuid — is the row itself present?
  const byId = await prisma.invoice.findUnique({
    where: { id: TARGET_ID },
    select: {
      id: true, number: true, issuedAt: true, status: true,
      garage: { select: { id: true, name: true } },
      jobCard: { select: { number: true, invoiceSentAt: true, invoiceDeliveredAt: true } },
    },
  });
  console.log(`--- by cuid ${TARGET_ID} ---`);
  if (byId) {
    console.log(JSON.stringify(byId, null, 2));
    console.log(`\nsignId("invoice", "${TARGET_ID}") = ${signId("invoice", TARGET_ID)}`);
    console.log(`Full customer URL: https://garageos.shop/c/invoice/${signId("invoice", TARGET_ID)}`);
  } else {
    console.log("NOT FOUND in prod");
  }

  // 2. By (number, year) — was there an INV-2026-0039 at all, maybe a
  //    different cuid (if preview + prod diverged)?
  const byNumber = await prisma.invoice.findMany({
    where: {
      number: TARGET_NUMBER,
      issuedAt: { gte: new Date(`${TARGET_YEAR}-01-01`), lt: new Date(`${TARGET_YEAR + 1}-01-01`) },
    },
    select: {
      id: true, number: true, issuedAt: true,
      garage: { select: { id: true, name: true } },
    },
  });
  console.log(`\n--- by (number=${TARGET_NUMBER}, year=${TARGET_YEAR}) ---`);
  if (byNumber.length === 0) {
    console.log("NOT FOUND in prod");
  } else {
    for (const inv of byNumber) {
      console.log(`  ${inv.id} · issued ${inv.issuedAt.toISOString()} · garage ${inv.garage.name}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
