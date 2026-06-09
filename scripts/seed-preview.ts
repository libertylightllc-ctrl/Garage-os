/**
 * Preview seed — leaves 4 jobs in different Part 4 stages so the user
 * can open each dashboard on their phone and see the new badges +
 * buttons in action. Returns the URLs to hit.
 */
import { prisma } from "@/lib/prisma";

const ago = (sec: number) => new Date(Date.now() - sec * 1000);

async function main() {
  const veh = await prisma.vehicle.findFirst({
    where: { customer: { name: "Khalid Customer" } },
    include: { customer: true },
  });
  if (!veh) throw new Error("seed vehicle missing");
  const advisor = await prisma.user.findFirst({ where: { role: "ADVISOR" } });
  const tech = await prisma.user.findFirst({ where: { role: "TECH" } });
  if (!advisor || !tech) throw new Error("seed users missing");

  let seq = (await prisma.garage.findUnique({ where: { id: advisor.garageId }, select: { jobSeq: true } }))?.jobSeq ?? 0;

  const ids: { stage: string; jobId: string; number: number; url: string }[] = [];

  async function nextNo() {
    const g = await prisma.garage.update({
      where: { id: advisor!.garageId },
      data: { jobSeq: { increment: 1 } },
      select: { jobSeq: true },
    });
    return g.jobSeq;
  }

  // ─── 1. Waiting for technician (Stage 2) ─────────────────────────────────
  {
    const n = await nextNo();
    const j = await prisma.jobCard.create({
      data: {
        garageId: advisor.garageId,
        vehicleId: veh.id,
        advisorId: advisor.id,
        number: n,
        status: "ARRIVED",
        complaint: "PREVIEW: WAITING_FOR_TECH",
        mileageIn: 50000,
        oilType: "NONE",
        exteriorCondition: [],
        interiorCondition: [],
        valuables: [],
      },
      select: { id: true, number: true },
    });
    ids.push({ stage: "Stage 2 · Waiting for technician", jobId: j.id, number: j.number!, url: `/advisor/jobs/${j.id}` });
  }

  // ─── 2. Technician diagnosing (Stage 3) ──────────────────────────────────
  {
    const n = await nextNo();
    const j = await prisma.jobCard.create({
      data: {
        garageId: advisor.garageId,
        vehicleId: veh.id,
        advisorId: advisor.id,
        number: n,
        status: "INSPECTION",
        claimedById: tech.id,
        claimedAt: ago(360), // 6m of diagnosis so far
        complaint: "PREVIEW: TECH_DIAGNOSING",
        mileageIn: 50000,
        oilType: "NONE",
        exteriorCondition: [],
        interiorCondition: [],
        valuables: [],
      },
      select: { id: true, number: true },
    });
    ids.push({ stage: "Stage 3 · Technician diagnosing", jobId: j.id, number: j.number!, url: `/advisor/jobs/${j.id}` });
  }

  // ─── 3. Awaiting customer approval (Stage 6) ─────────────────────────────
  {
    const n = await nextNo();
    const j = await prisma.jobCard.create({
      data: {
        garageId: advisor.garageId,
        vehicleId: veh.id,
        advisorId: advisor.id,
        number: n,
        status: "ESTIMATE",
        claimedById: tech.id,
        claimedAt: ago(1500),
        sentForEstimateAt: ago(900), // 10m diagnosis
        complaint: "PREVIEW: AWAITING_CUSTOMER_APPROVAL",
        mileageIn: 50000,
        oilType: "NONE",
        exteriorCondition: [],
        interiorCondition: [],
        valuables: [],
      },
      select: { id: true, number: true },
    });
    await prisma.estimate.create({
      data: {
        jobCardId: j.id,
        subtotal: 600,
        vatAmount: 30,
        total: 630,
        status: "SENT",
        sentAt: ago(420), // 8m pricing
        createdAt: ago(840),
        lines: { create: [
          { kind: "LABOR", description: "Brake pad replacement", qty: 1, unitPrice: 400, lineTotal: 400 },
          { kind: "PART", description: "Front brake pads", qty: 1, unitPrice: 200, lineTotal: 200 },
        ]},
      },
    });
    ids.push({ stage: "Stage 6 · Awaiting customer approval", jobId: j.id, number: j.number!, url: `/advisor/jobs/${j.id}` });
  }

  // ─── 4. Complete — awaiting invoice (Stage 8) ────────────────────────────
  {
    const n = await nextNo();
    const j = await prisma.jobCard.create({
      data: {
        garageId: advisor.garageId,
        vehicleId: veh.id,
        advisorId: advisor.id,
        number: n,
        status: "TECH_COMPLETE",
        claimedById: tech.id,
        claimedAt: ago(3600),
        sentForEstimateAt: ago(3000),
        workCompletedAt: ago(300), // 5m ago
        complaint: "PREVIEW: COMPLETE_AWAITING_INVOICE",
        mileageIn: 50000,
        oilType: "NONE",
        exteriorCondition: [],
        interiorCondition: [],
        valuables: [],
      },
      select: { id: true, number: true },
    });
    await prisma.estimate.create({
      data: {
        jobCardId: j.id,
        subtotal: 850,
        vatAmount: 42.5,
        total: 892.5,
        status: "APPROVED",
        sentAt: ago(2700),
        approvedAt: ago(2400),
        approvedAmount: 892.5,
        createdAt: ago(2900),
        lines: { create: [
          { kind: "LABOR", description: "Full service", qty: 1, unitPrice: 650, lineTotal: 650 },
          { kind: "PART", description: "Oil + filters", qty: 1, unitPrice: 200, lineTotal: 200 },
        ]},
      },
    });
    ids.push({ stage: "Stage 8 · Complete — awaiting invoice", jobId: j.id, number: j.number!, url: `/advisor/jobs/${j.id}` });
  }

  console.log("");
  console.log("Seeded 4 preview jobs on prod. Open these on iPhone / laptop:");
  console.log("");
  console.log("  https://garage-os-puce.vercel.app/advisor      (advisor home — all 4 visible)");
  console.log("  https://garage-os-puce.vercel.app/technician   (tech home — Stage 3 + 8 are 'mine')");
  console.log("  https://garage-os-puce.vercel.app/cashier      (cashier home — Stage 8 in to-price)");
  console.log("");
  for (const r of ids) {
    console.log(`  #${r.number} ${r.stage}`);
    console.log(`     https://garage-os-puce.vercel.app${r.url}`);
  }
  console.log("");
  console.log("To remove these 4 jobs after preview, run cleanup with the IDs:");
  console.log(JSON.stringify(ids.map(r => r.jobId)));
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
