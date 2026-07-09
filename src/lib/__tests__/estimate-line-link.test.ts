/**
 * Inventory 3b — OPTIONAL catalog link on estimate lines.
 *   1. Advisor/owner adds a line WITH partId → link stored, kind forced to
 *      PART, stock NOT moved (display/link only).
 *   2. Free-text line (no partId) → byte-identical to before (partId null).
 *   3. A part from another garage is rejected; no line created.
 *   4. Blank description with a linked part defaults to "name (sku)".
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

const { addEstimateLineAction } = await import("@/app/actions/billing");

const P = "est-link-test-";
const gA = P + "garage-A";
const gB = P + "garage-B";

const advisor = (garageId: string) => ({
  user: { id: P + "adv", role: "ADVISOR", garageId, email: "x", name: "x" },
});
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function setup() {
  for (const g of [gA, gB]) {
    await prisma.garage.upsert({ where: { id: g }, update: {}, create: { id: g, name: g } });
  }
  const customer = await prisma.customer.create({ data: { garageId: gA, name: "C", phone: P + Math.random() } });
  const vehicle = await prisma.vehicle.create({
    data: { customerId: customer.id, make: "T", model: "C", plate: "L-" + Math.random().toString(36).slice(2, 8) },
  });
  const job = await prisma.jobCard.create({ data: { garageId: gA, vehicleId: vehicle.id, status: "ESTIMATE" } });
  const est = await prisma.estimate.create({
    data: { jobCardId: job.id, subtotal: 0, vatAmount: 0, total: 0, status: "DRAFT" },
  });
  const mkPart = (garageId: string) =>
    prisma.part.create({
      data: {
        garageId,
        sku: P + Math.random().toString(36).slice(2, 8),
        name: "Oil Filter",
        cost: "10",
        price: "25",
        qtyOnHand: 12,
      },
    });
  return { est, partA: await mkPart(gA), partB: await mkPart(gB) };
}

async function cleanup() {
  await prisma.estimateLine.deleteMany({ where: { estimate: { jobCard: { garageId: { startsWith: P } } } } });
  await prisma.estimate.deleteMany({ where: { jobCard: { garageId: { startsWith: P } } } });
  await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: { startsWith: P } } } });
  await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.part.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
  await cleanup();
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(advisor(gA));
});
afterAll(cleanup);

describe("3b — optional catalog link on estimate lines", () => {
  it("linked line stores partId, forces PART kind, and moves NO stock", async () => {
    const { est, partA } = await setup();
    await addEstimateLineAction(
      form({ estimateId: est.id, partId: partA.id, kind: "LABOR", description: "Oil filter", qty: "2", unitPrice: "25" }),
    );
    const line = await prisma.estimateLine.findFirst({ where: { estimateId: est.id } });
    expect(line!.partId).toBe(partA.id);
    expect(line!.kind).toBe("PART"); // linked → PART even though form said LABOR
    const part = await prisma.part.findUnique({ where: { id: partA.id } });
    expect(part!.qtyOnHand).toBe(12); // display/link only — stock untouched
  });

  it("free-text line (no pick) is byte-identical to before", async () => {
    const { est } = await setup();
    await addEstimateLineAction(
      form({ estimateId: est.id, kind: "LABOR", description: "AC diagnosis", qty: "1", unitPrice: "150" }),
    );
    const line = await prisma.estimateLine.findFirst({ where: { estimateId: est.id } });
    expect(line!.partId).toBeNull();
    expect(line!.kind).toBe("LABOR");
    expect(line!.description).toBe("AC diagnosis");
  });

  it("rejects a part from another garage; no line created", async () => {
    const { est, partB } = await setup();
    await expect(
      addEstimateLineAction(
        form({ estimateId: est.id, partId: partB.id, kind: "PART", description: "x", qty: "1", unitPrice: "1" }),
      ),
    ).rejects.toThrow(/not found in this garage/i);
    expect(await prisma.estimateLine.count({ where: { estimateId: est.id } })).toBe(0);
  });

  it("blank description on a linked line defaults to name (sku)", async () => {
    const { est, partA } = await setup();
    await addEstimateLineAction(
      form({ estimateId: est.id, partId: partA.id, kind: "PART", description: "", qty: "1", unitPrice: "25" }),
    );
    const line = await prisma.estimateLine.findFirst({ where: { estimateId: est.id } });
    expect(line!.description).toBe(`Oil Filter (${partA.sku})`);
  });
});
