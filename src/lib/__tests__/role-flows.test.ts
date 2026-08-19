/**
 * Per-role END-TO-END flow tests — structural prevention for the class of
 * bug behind prod incident ref 3426515655 (a permission guard missed in one
 * step of a role's journey). Each test walks a role's WHOLE flow through the
 * real ACTIONS (not page access), so a broken guard at any single step fails
 * the run:
 *
 *   OWNER   — manual intake (the exact step that broke) → create + price
 *             estimate → approve → invoice → record payment.
 *   ADVISOR — manual intake → create + price estimate → adjust a price →
 *             mark sent; still cannot invoice.
 *   CASHIER — given an approved estimate: invoice → record payment; still
 *             cannot create jobs or price estimates.
 *   TECH    — claim → free-text part request → send for estimate; still
 *             cannot create jobs or estimates.
 *   MASTER  — the owner-created do-everything operational role: the WHOLE
 *             flow under one login (intake → claim → estimate → price →
 *             approve → invoice → payment), but BLOCKED from owner-only
 *             work and redirected away from the owner dashboard.
 *
 * Cleanup by garage-id prefix.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { createCustomerVehicleJobAction } = await import("@/app/actions/intake-moulkia");
const { createJobCardAction, claimJobAction, sendForEstimateAction } = await import("@/app/actions/jobs");
const {
  createEstimateAction,
  addEstimateLineAction,
  updateEstimateLinePriceAction,
  setEstimateStatusAction,
  generateInvoiceAction,
  recordPaymentAction,
} = await import("@/app/actions/billing");
const { requestPartAction } = await import("@/app/actions/parts");
const { addBayAction } = await import("@/app/actions/onboarding");
const { requireRole: requirePageRole } = await import("@/lib/guard");

const P = "role-flow-test-";
const gA = P + "garage-A";

const as = (role: string) => ({
  user: { id: P + "u-" + role.toLowerCase(), role, garageId: gA, email: "x", name: "x" },
});
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
function receptionForm(): FormData {
  return form({
    via: "manual",
    ownerName: "Flow Customer",
    phone: P + Math.random().toString().slice(2, 10),
    plate: "RF-" + Math.random().toString(36).slice(2, 8),
    make: "Toyota",
    model: "Hilux",
    mileageIn: "60000",
    complaint: "Brake noise",
  });
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

async function setup() {
  await prisma.garage.upsert({ where: { id: gA }, update: {}, create: { id: gA, name: gA } });
  for (const role of ["OWNER", "ADVISOR", "TECH", "CASHIER", "MASTER"]) {
    const id = P + "u-" + role.toLowerCase();
    await prisma.user.upsert({
      where: { id },
      update: {},
      create: { id, garageId: gA, role: role as never, name: role, email: id + "@test.local" },
    });
  }
}

async function cleanup() {
  const inGarage = { jobCard: { garageId: { startsWith: P } } };
  // Payment / non-DRAFT Invoice deletes go through the ledger-source
  // delete triggers — cleanup routes through the bypass.
  await withDeleteGuardBypass(prisma, async (tx) => {
    await tx.payment.deleteMany({ where: { invoice: inGarage } });
    await tx.invoiceLine.deleteMany({ where: { invoice: inGarage } });
    await tx.invoice.deleteMany({ where: { garageId: { startsWith: P } } });
  });
  await prisma.ledgerEntry.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.estimateLine.deleteMany({ where: { estimate: inGarage } });
  await prisma.estimate.deleteMany({ where: inGarage });
  await prisma.partRequest.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.jobStep.deleteMany({ where: inGarage });
  await prisma.workSession.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: { startsWith: P } } } });
  // marking an estimate SENT opens a WhatsApp thread for the customer
  await prisma.whatsAppMessage.deleteMany({ where: { thread: { garageId: { startsWith: P } } } });
  await prisma.whatsAppThread.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
  await cleanup();
  await setup();
  mockAuth.mockReset();
});
afterAll(cleanup);

/** Intake as `role`, returns the new jobId. */
async function intakeJob(role: string): Promise<string> {
  mockAuth.mockResolvedValue(as(role));
  const to = await call(createCustomerVehicleJobAction, receptionForm());
  // redirect shape: /advisor/jobs/new/done?jobId=<id>
  const jobId = to.match(/jobId=([a-z0-9]+)/)?.[1];
  expect(jobId, `intake as ${role} should land on the new job (got ${to})`).toBeTruthy();
  return jobId!;
}
/** Estimate + one priced line on jobId as the CURRENT mocked role; returns estimateId. */
async function priceEstimate(jobId: string): Promise<string> {
  const estUrl = await call(createEstimateAction, form({ jobId }));
  const estId = estUrl.split("/").pop()!;
  await call(
    addEstimateLineAction,
    form({ estimateId: estId, kind: "PART", description: "Front brake pads", qty: "1", unitPrice: "400" }),
  );
  return estId;
}

describe("per-role end-to-end flows", () => {
  it("OWNER: intake → estimate → price → approve → invoice → paid (the incident chain)", async () => {
    mockAuth.mockResolvedValue(as("OWNER"));
    const jobId = await intakeJob("OWNER");
    const estId = await priceEstimate(jobId);

    await prisma.estimate.update({ where: { id: estId }, data: { status: "APPROVED" } });
    const invUrl = await call(generateInvoiceAction, form({ estimateId: estId }));
    const invId = invUrl.split("/").pop()!;
    await call(recordPaymentAction, form({ invoiceId: invId, method: "CASH", amount: "420" }));

    const inv = await prisma.invoice.findUnique({ where: { id: invId }, include: { payments: true } });
    expect(inv!.payments).toHaveLength(1);
    expect(String(inv!.total)).toBe("420"); // 400 + 5% VAT
  });

  it("ADVISOR: intake → estimate → price → adjust → sent; cannot invoice", async () => {
    mockAuth.mockResolvedValue(as("ADVISOR"));
    const jobId = await intakeJob("ADVISOR");
    const estId = await priceEstimate(jobId);

    const line = await prisma.estimateLine.findFirst({ where: { estimateId: estId } });
    await call(
      updateEstimateLinePriceAction,
      form({ estimateId: estId, lineId: line!.id, unitPrice: "450" }),
    );
    await call(setEstimateStatusAction, form({ estimateId: estId, status: "SENT" }));

    const est = await prisma.estimate.findUnique({ where: { id: estId } });
    expect(est!.status).toBe("SENT");
    expect(String(est!.total)).toBe("472.5"); // 450 + 5% VAT

    // boundary unchanged: advisor cannot invoice
    await prisma.estimate.update({ where: { id: estId }, data: { status: "APPROVED" } });
    await expect(call(generateInvoiceAction, form({ estimateId: estId }))).rejects.toThrow();
  });

  it("CASHIER: approved estimate → invoice → paid; cannot create jobs or price", async () => {
    // setup by advisor
    const jobId = await intakeJob("ADVISOR");
    const estId = await priceEstimate(jobId);
    await prisma.estimate.update({ where: { id: estId }, data: { status: "APPROVED" } });

    // cashier takes over
    mockAuth.mockResolvedValue(as("CASHIER"));
    const invUrl = await call(generateInvoiceAction, form({ estimateId: estId }));
    const invId = invUrl.split("/").pop()!;
    await call(recordPaymentAction, form({ invoiceId: invId, method: "CARD_POS", amount: "420" }));
    const inv = await prisma.invoice.findUnique({ where: { id: invId }, include: { payments: true } });
    expect(inv!.payments).toHaveLength(1);

    // boundaries unchanged
    await expect(call(createCustomerVehicleJobAction, receptionForm())).rejects.toThrow(/Not authorized/);
    await expect(
      call(addEstimateLineAction, form({ estimateId: estId, kind: "LABOR", description: "x", qty: "1", unitPrice: "1" })),
    ).rejects.toThrow(/Not authorized/);
  });

  it("MASTER: the whole operational flow on one login; blocked from owner work", async () => {
    mockAuth.mockResolvedValue(as("MASTER"));

    // advisor seat: intake
    const jobId = await intakeJob("MASTER");
    // tech seat: claim the car
    await call(claimJobAction, form({ jobId }));
    const job = await prisma.jobCard.findUnique({ where: { id: jobId } });
    expect(job!.claimedById).toBe(P + "u-master");
    // advisor seat: estimate + price
    const estId = await priceEstimate(jobId);
    // customer approves…
    await prisma.estimate.update({ where: { id: estId }, data: { status: "APPROVED" } });
    // cashier seat: invoice + payment
    const invUrl = await call(generateInvoiceAction, form({ estimateId: estId }));
    const invId = invUrl.split("/").pop()!;
    await call(recordPaymentAction, form({ invoiceId: invId, method: "CASH", amount: "420" }));
    const inv = await prisma.invoice.findUnique({ where: { id: invId }, include: { payments: true } });
    expect(inv!.payments).toHaveLength(1);
    expect(String(inv!.total)).toBe("420"); // 400 + 5% VAT

    // owner boundary holds BOTH ways:
    // 1. owner-only ACTIONS throw
    await expect(call(addBayAction, form({ name: "Bay X" }))).rejects.toThrow(/Not authorized/);
    // 2. the owner DASHBOARD page guard redirects MASTER to its own home
    await expect(requirePageRole("OWNER")).rejects.toThrow("REDIRECT:/advisor");
  });

  it("TECH: claim → part request → send for estimate; cannot create jobs or estimates", async () => {
    const jobId = await intakeJob("ADVISOR");

    mockAuth.mockResolvedValue(as("TECH"));
    await call(claimJobAction, form({ jobId }));
    let job = await prisma.jobCard.findUnique({ where: { id: jobId } });
    expect(job!.claimedById).toBe(P + "u-tech");
    expect(job!.status).toBe("INSPECTION");

    await call(requestPartAction, form({ jobId, description: "Brake caliper bolt", qty: "2" }));
    expect(await prisma.partRequest.count({ where: { jobCardId: jobId } })).toBe(1);

    // out-of-stock free-text request auto-paused the job; sending for
    // estimate is allowed from ON_HOLD and clears the hold.
    const to = await call(sendForEstimateAction, form({ jobId }));
    expect(to).toContain("sent-to-advisor");
    job = await prisma.jobCard.findUnique({ where: { id: jobId } });
    expect(job!.status).toBe("ESTIMATE");

    // boundaries unchanged
    await expect(call(createCustomerVehicleJobAction, receptionForm())).rejects.toThrow(/Not authorized/);
    await expect(call(createEstimateAction, form({ jobId }))).rejects.toThrow(/Not authorized/);
  });
});
