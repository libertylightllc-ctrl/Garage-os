import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
// Load `.env.local` for DATABASE_URL, then `.env` for AUTH_SECRET
// (base secret only lives in .env). Order matters — .env.local wins
// on DATABASE_URL because of `override: true` on the first call.
const envLocal = path.resolve(".env.local");
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal, override: true });
}
dotenv.config({ path: path.resolve(".env") });

// Seeds an Estimate on the 12-line print fixture so the DocumentHeader
// sweep is verifiable on a real staff-side page (/estimates/[id]) and
// the customer-facing signed link (/c/estimate/[token]).

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { signId } = await import("../src/lib/tokens");
  const garageId = "demo-garage";

  const job = await prisma.jobCard.findUnique({
    where: { id: "print-12line-2026-07-24" },
    include: { vehicle: true },
  });
  if (!job) throw new Error("Print fixture missing — run seed-print-12line-fixture first");

  const EST_ID = "doc-header-estimate-01";
  let est = await prisma.estimate.findUnique({ where: { id: EST_ID } });
  if (!est) {
    est = await prisma.estimate.create({
      data: {
        id: EST_ID,
        jobCardId: job.id,
        status: "SENT",
        sentAt: new Date("2026-07-24T10:00:00+04:00"),
        subtotal: "480.00",
        vatAmount: "24.00",
        total: "504.00",
      },
    });
    await prisma.estimateLine.createMany({
      data: [
        { estimateId: est.id, kind: "LABOR", description: "AC compressor service", qty: "1", unitPrice: "180.00", lineTotal: "180.00" },
        { estimateId: est.id, kind: "PART", description: "Cabin air filter", qty: "1", unitPrice: "60.00", lineTotal: "60.00" },
        { estimateId: est.id, kind: "PART", description: "Rear wiper blade", qty: "1", unitPrice: "40.00", lineTotal: "40.00" },
        { estimateId: est.id, kind: "LABOR", description: "Battery drain diagnosis", qty: "2", unitPrice: "100.00", lineTotal: "200.00" },
      ],
    });
  }

  const custEstToken = signId("estimate", est.id);
  const custDelToken = signId("delivery", job.id);

  console.log(
    JSON.stringify(
      {
        internalEstimate: `http://localhost:3000/estimates/${est.id}`,
        internalEstimatePreview: `http://localhost:3000/estimates/${est.id}/preview`,
        customerEstimate: `http://localhost:3000/c/estimate/${custEstToken}`,
        customerDelivery: `http://localhost:3000/c/delivery/${custDelToken}`,
        printJobCard: `http://localhost:3000/advisor/jobs/${job.id}/print`,
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
