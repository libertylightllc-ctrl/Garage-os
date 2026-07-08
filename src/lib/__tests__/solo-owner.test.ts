/**
 * Solo-owner slice — permission boundaries BOTH ways.
 *
 * OWNER gained (this slice):
 *   1. createJobCardAction — owner creates a job.
 *   2. jobActionAction — owner drives job transitions.
 *   3. Full solo money flow at the action layer: create job → create
 *      estimate → price a line → (approve) → generate invoice → record
 *      payment, all on the OWNER login, no other role account involved.
 *
 * NOTHING else moved (additive-only):
 *   4. TECH / CASHIER still cannot create jobs.
 *   5. OWNER still cannot claim a job (tech-only — claim-lock + stats).
 *   6. ADVISOR can still create jobs (team handoff unchanged).
 *   7. ADVISOR still cannot invoice; CASHIER still cannot price estimates.
 *
 * Cleanup by garage-id prefix.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { createJobCardAction, jobActionAction, claimJobAction } = await import("@/app/actions/jobs");
const { createEstimateAction, addEstimateLineAction, generateInvoiceAction, recordPaymentAction } =
  await import("@/app/actions/billing");

const P = "solo-owner-test-";
const gA = P + "garage-A";

const as = (role: string) => ({
  user: { id: P + "u-" + role.toLowerCase(), role, garageId: gA, email: "x", name: "x" },
});
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
/** Run an action; return the redirect target ("" if none), rethrow real errors. */
async function call(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<string> {
  try {
    await action(fd);
    return "";
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("REDIRECT:")) return m.slice("REDIRECT:".length);
    throw e;
  }
}

async function setupVehicle() {
  await prisma.garage.upsert({ where: { id: gA }, update: {}, create: { id: gA, name: gA } });
  // Real User rows for every mocked session id — createJobCardAction writes
  // advisorId: user.id (FK to User).
  for (const role of ["OWNER", "ADVISOR", "TECH", "CASHIER"]) {
    const id = P + "u-" + role.toLowerCase();
    await prisma.user.upsert({
      where: { id },
      update: {},
      create: { id, garageId: gA, role: role as never, name: role, email: id + "@test.local" },
    });
  }
  const customer = await prisma.customer.create({
    data: { garageId: gA, name: "Solo Customer", phone: P + Math.random() },
  });
  return prisma.vehicle.create({
    data: {
      customerId: customer.id,
      make: "Nissan",
      model: "Patrol",
      plate: "S-" + Math.random().toString(36).slice(2, 8),
    },
  });
}

async function cleanup() {
  const where = { jobCard: { garageId: { startsWith: P } } };
  await prisma.payment.deleteMany({ where: { invoice: where } });
  await prisma.ledgerEntry.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.invoiceLine.deleteMany({ where: { invoice: where } });
  await prisma.invoice.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.estimateLine.deleteMany({ where: { estimate: where } });
  await prisma.estimate.deleteMany({ where });
  await prisma.jobStep.deleteMany({ where });
  await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: { startsWith: P } } } });
  await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
  await cleanup();
  mockAuth.mockReset();
});
afterAll(cleanup);

describe("solo owner — OWNER gained the job flow", () => {
  it("OWNER creates a job card", async () => {
    const vehicle = await setupVehicle();
    mockAuth.mockResolvedValue(as("OWNER"));
    await call(createJobCardAction, form({ vehicleId: vehicle.id }));
    const job = await prisma.jobCard.findFirst({ where: { garageId: gA } });
    expect(job).not.toBeNull();
    expect(job!.status).toBe("ARRIVED");
  });

  it("OWNER drives a job transition (ADVANCE)", async () => {
    const vehicle = await setupVehicle();
    const job = await prisma.jobCard.create({
      data: { garageId: gA, vehicleId: vehicle.id, status: "ARRIVED" },
    });
    mockAuth.mockResolvedValue(as("OWNER"));
    await call(jobActionAction, form({ jobId: job.id, action: "ADVANCE" }));
    const after = await prisma.jobCard.findUnique({ where: { id: job.id } });
    expect(after!.status).not.toBe("ARRIVED"); // moved forward
  });

  it("OWNER runs the FULL money flow solo: job → estimate → line → invoice → paid", async () => {
    const vehicle = await setupVehicle();
    mockAuth.mockResolvedValue(as("OWNER"));

    // 1. create job
    await call(createJobCardAction, form({ vehicleId: vehicle.id }));
    const job = await prisma.jobCard.findFirst({ where: { garageId: gA } });

    // 2. create + price the estimate (the advisor-pricing boundary)
    const estUrl = await call(createEstimateAction, form({ jobId: job!.id }));
    const estId = estUrl.split("/").pop()!;
    expect(estId).toBeTruthy();
    await call(
      addEstimateLineAction,
      form({ estimateId: estId, kind: "LABOR", description: "AC repair", qty: "1", unitPrice: "500" }),
    );
    const line = await prisma.estimateLine.findFirst({ where: { estimateId: estId } });
    expect(String(line!.unitPrice)).toBe("500");

    // 3. customer approves (status set directly — the send/approve actions
    //    already admit OWNER via SEND_ROLES and are covered elsewhere)
    await prisma.estimate.update({ where: { id: estId }, data: { status: "APPROVED" } });

    // 4. invoice
    const invUrl = await call(generateInvoiceAction, form({ estimateId: estId }));
    const invId = invUrl.split("/").pop()!;
    expect(invId).toBeTruthy();

    // 5. record payment (500 + 5% VAT)
    await call(recordPaymentAction, form({ invoiceId: invId, method: "CASH", amount: "525" }));
    const inv = await prisma.invoice.findUnique({ where: { id: invId }, include: { payments: true } });
    expect(inv!.payments.length).toBeGreaterThan(0);
  });
});

describe("solo owner — nothing else moved", () => {
  it("TECH and CASHIER still cannot create jobs", async () => {
    const vehicle = await setupVehicle();
    for (const role of ["TECH", "CASHIER"]) {
      mockAuth.mockResolvedValue(as(role));
      await expect(call(createJobCardAction, form({ vehicleId: vehicle.id }))).rejects.toThrow(
        /Not authorized/,
      );
    }
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(0);
  });

  it("OWNER still cannot claim a job (tech-only claim-lock)", async () => {
    const vehicle = await setupVehicle();
    const job = await prisma.jobCard.create({
      data: { garageId: gA, vehicleId: vehicle.id, status: "ARRIVED" },
    });
    mockAuth.mockResolvedValue(as("OWNER"));
    await expect(call(claimJobAction, form({ jobId: job.id }))).rejects.toThrow(/Not authorized/);
    const after = await prisma.jobCard.findUnique({ where: { id: job.id } });
    expect(after!.claimedById).toBeNull();
  });

  it("ADVISOR still creates jobs exactly as before", async () => {
    const vehicle = await setupVehicle();
    mockAuth.mockResolvedValue(as("ADVISOR"));
    await call(createJobCardAction, form({ vehicleId: vehicle.id }));
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(1);
  });

  it("ADVISOR still cannot invoice; CASHIER still cannot price estimates", async () => {
    const vehicle = await setupVehicle();
    mockAuth.mockResolvedValue(as("ADVISOR"));
    await call(createJobCardAction, form({ vehicleId: vehicle.id }));
    const job = await prisma.jobCard.findFirst({ where: { garageId: gA } });
    const estUrl = await call(createEstimateAction, form({ jobId: job!.id }));
    const estId = estUrl.split("/").pop()!;
    await prisma.estimate.update({ where: { id: estId }, data: { status: "APPROVED" } });

    // advisor → invoice: blocked (INVOICE_ROLES unchanged)
    await expect(call(generateInvoiceAction, form({ estimateId: estId }))).rejects.toThrow();

    // cashier → estimate line edit: blocked (ESTIMATE_CREATE_ROLES unchanged)
    mockAuth.mockResolvedValue(as("CASHIER"));
    await expect(
      call(
        addEstimateLineAction,
        form({ estimateId: estId, kind: "LABOR", description: "x", qty: "1", unitPrice: "1" }),
      ),
    ).rejects.toThrow();
  });
});
