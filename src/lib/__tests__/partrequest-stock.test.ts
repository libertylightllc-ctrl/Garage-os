/**
 * Inventory 3d — stock-integrity guards on the part-request lifecycle.
 * The fulfilment decrement is the one stock movement inside the LIVE job flow,
 * so it gets the same atomic guards as PO receive/return (2b/2c):
 *   1. Fulfilling a catalog request decrements stock exactly once + logs a movement.
 *   2. Fulfilling with insufficient stock fails cleanly — no negative qtyOnHand,
 *      request stays in its prior status (transaction rolls back).
 *   3. Two concurrent fulfilments: exactly ONE wins; stock decrements once.
 *   4. Free-text requests (no catalog part) fulfil without touching stock.
 *   5. ARRIVED → ORDERED (wrong/late part) reversal is also floored at zero.
 *   6. Garage isolation: another garage's advisor cannot advance the request.
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

const { fulfillPartRequestAction, orderPartRequestAction } = await import("@/app/actions/parts");

const P = "pr-stock-test-";
const gA = P + "garage-A";
const gB = P + "garage-B";

function advisor(garageId: string) {
  return { user: { id: P + "adv", role: "ADVISOR", garageId, email: "x", name: "x" } };
}
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function setupJob(garageId: string) {
  await prisma.garage.upsert({ where: { id: garageId }, update: {}, create: { id: garageId, name: garageId } });
  const customer = await prisma.customer.create({ data: { garageId, name: "C", phone: P + Math.random() } });
  const vehicle = await prisma.vehicle.create({
    data: {
      customerId: customer.id,
      make: "Test",
      model: "Car",
      plate: "T-" + Math.random().toString(36).slice(2, 8),
    },
  });
  return prisma.jobCard.create({ data: { garageId, vehicleId: vehicle.id, status: "REPAIR" } });
}

async function makeRequest(garageId: string, opts: { qtyOnHand?: number; qty: number; status: string; catalog?: boolean }) {
  const job = await setupJob(garageId);
  let partId: string | null = null;
  if (opts.catalog !== false) {
    const part = await prisma.part.create({
      data: {
        garageId,
        sku: P + Math.random().toString(36).slice(2, 8),
        name: "Test part",
        cost: "10",
        price: "20",
        qtyOnHand: opts.qtyOnHand ?? 0,
      },
    });
    partId = part.id;
  }
  const req = await prisma.partRequest.create({
    data: {
      garageId,
      jobCardId: job.id,
      partId,
      description: "Test part",
      qty: opts.qty,
      status: opts.status as never,
    },
  });
  return { req, partId, jobId: job.id };
}

async function cleanup() {
  await prisma.partMovement.deleteMany({ where: { part: { garageId: { startsWith: P } } } });
  await prisma.partRequest.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.part.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.jobStep.deleteMany({ where: { jobCard: { garageId: { startsWith: P } } } });
  await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: { startsWith: P } } } });
  await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
  await cleanup();
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(advisor(gA));
});
afterAll(cleanup);

describe("3d — fulfilment stock guards", () => {
  it("fulfils a catalog request: decrements once + logs a movement", async () => {
    const { req, partId } = await makeRequest(gA, { qtyOnHand: 10, qty: 4, status: "ARRIVED" });
    await fulfillPartRequestAction(form({ requestId: req.id }));

    const part = await prisma.part.findUnique({ where: { id: partId! } });
    expect(part!.qtyOnHand).toBe(6);
    const after = await prisma.partRequest.findUnique({ where: { id: req.id } });
    expect(after!.status).toBe("FULFILLED");
    const moves = await prisma.partMovement.findMany({ where: { partId: partId! } });
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(-4);
  });

  it("refuses to fulfil past zero: no negative stock, request stays put", async () => {
    const { req, partId } = await makeRequest(gA, { qtyOnHand: 3, qty: 10, status: "ARRIVED" });
    await expect(fulfillPartRequestAction(form({ requestId: req.id }))).rejects.toThrow(/Not enough stock/);

    const part = await prisma.part.findUnique({ where: { id: partId! } });
    expect(part!.qtyOnHand).toBe(3); // untouched
    const after = await prisma.partRequest.findUnique({ where: { id: req.id } });
    expect(after!.status).toBe("ARRIVED"); // transaction rolled back
    expect(await prisma.partMovement.count({ where: { partId: partId! } })).toBe(0);
  });

  it("two concurrent fulfilments: exactly one wins, stock decrements once", async () => {
    const { req, partId } = await makeRequest(gA, { qtyOnHand: 10, qty: 4, status: "ARRIVED" });
    const results = await Promise.allSettled([
      fulfillPartRequestAction(form({ requestId: req.id })),
      fulfillPartRequestAction(form({ requestId: req.id })),
    ]);

    const wins = results.filter((r) => r.status === "fulfilled").length;
    expect(wins).toBe(1);
    const part = await prisma.part.findUnique({ where: { id: partId! } });
    expect(part!.qtyOnHand).toBe(6); // decremented once, not twice
    expect(await prisma.partMovement.count({ where: { partId: partId! } })).toBe(1);
  });

  it("free-text request (no catalog part) fulfils without touching stock", async () => {
    const { req } = await makeRequest(gA, { qty: 2, status: "REQUESTED", catalog: false });
    await fulfillPartRequestAction(form({ requestId: req.id }));
    const after = await prisma.partRequest.findUnique({ where: { id: req.id } });
    expect(after!.status).toBe("FULFILLED");
  });

  it("ARRIVED → ORDERED reversal is floored at zero too", async () => {
    // Stock the arrival brought in was already consumed elsewhere.
    const { req, partId } = await makeRequest(gA, { qtyOnHand: 1, qty: 5, status: "ARRIVED" });
    await expect(orderPartRequestAction(form({ requestId: req.id }))).rejects.toThrow(/Not enough stock/);
    const part = await prisma.part.findUnique({ where: { id: partId! } });
    expect(part!.qtyOnHand).toBe(1);
    const after = await prisma.partRequest.findUnique({ where: { id: req.id } });
    expect(after!.status).toBe("ARRIVED");
  });

  it("another garage's advisor cannot advance the request", async () => {
    const { req, partId } = await makeRequest(gA, { qtyOnHand: 10, qty: 4, status: "ARRIVED" });
    mockAuth.mockResolvedValue(advisor(gB));
    await prisma.garage.upsert({ where: { id: gB }, update: {}, create: { id: gB, name: gB } });
    await expect(fulfillPartRequestAction(form({ requestId: req.id }))).rejects.toThrow(/not found/i);
    const part = await prisma.part.findUnique({ where: { id: partId! } });
    expect(part!.qtyOnHand).toBe(10);
  });
});
