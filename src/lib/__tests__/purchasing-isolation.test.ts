/**
 * Inventory 2a — tenant-isolation + permission tests for purchase orders.
 * Proves:
 *   1. createPurchaseOrderAction writes to the CALLER'S garage and only
 *      accepts a supplier from that garage.
 *   2. addPoLineAction only accepts a part from the caller's garage, only
 *      on a DRAFT, and rejects a PO from another garage.
 *   3. setPoStatusAction enforces the DRAFT→ORDERED (needs a line) and
 *      cancel rules, garage-scoped.
 *   4. Only OWNER can do any of it.
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

const { createPurchaseOrderAction, addPoLineAction, removePoLineAction, setPoStatusAction } =
  await import("@/app/actions/purchasing");

const P = "po-iso-test-";
const gA = P + "garage-A";
const gB = P + "garage-B";

function owner(garageId: string) {
  return { user: { id: P + "u", role: "OWNER", garageId, email: "x", name: "x" } };
}
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
async function call(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<string> {
  try {
    await action(fd);
    return "(no redirect)";
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("REDIRECT:")) return m.slice("REDIRECT:".length);
    throw e;
  }
}
const supplier = (garageId: string, name = "S") =>
  prisma.supplier.create({ data: { garageId, name } });
const part = (garageId: string, sku: string) =>
  prisma.part.create({ data: { garageId, sku, name: "P " + sku, cost: "5", price: "9" } });

async function cleanup() {
  await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { garageId: { startsWith: P } } } });
  await prisma.purchaseOrder.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.part.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.supplier.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}
beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: gA, name: P + "A" } });
  await prisma.garage.create({ data: { id: gB, name: P + "B" } });
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createPurchaseOrderAction", { retry: 3 }, () => {
  it("creates a DRAFT PO in the caller's garage for its own supplier", async () => {
    const s = await supplier(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(createPurchaseOrderAction, form({ supplierId: s.id, reference: "Q-1" }));
    expect(to).toMatch(/^\/owner\/purchasing\/.+/);
    const pos = await prisma.purchaseOrder.findMany({ where: { garageId: gA } });
    expect(pos.length).toBe(1);
    expect(pos[0].status).toBe("DRAFT");
    expect(pos[0].reference).toBe("Q-1");
  });

  it("refuses a supplier from another garage", async () => {
    const sB = await supplier(gB);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(createPurchaseOrderAction, form({ supplierId: sB.id }));
    expect(to).toContain("error=");
    expect((await prisma.purchaseOrder.findMany({ where: { garageId: gA } })).length).toBe(0);
  });

  it("rejects a non-owner", async () => {
    const s = await supplier(gA);
    mockAuth.mockResolvedValueOnce({ user: { id: "x", role: "ADVISOR", garageId: gA, email: "x", name: "x" } });
    await expect(createPurchaseOrderAction(form({ supplierId: s.id }))).rejects.toThrow("Not authorized");
  });
});

async function draftPO(garageId: string) {
  const s = await supplier(garageId);
  return prisma.purchaseOrder.create({ data: { garageId, supplierId: s.id } });
}

describe("addPoLineAction", { retry: 3 }, () => {
  it("adds a line with the caller's own part", async () => {
    const po = await draftPO(gA);
    const p = await part(gA, "A1");
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(addPoLineAction, form({ poId: po.id, partId: p.id, qty: "4", unitCost: "7.50" }));
    const lines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
    expect(lines.length).toBe(1);
    expect(lines[0].qty).toBe(4);
    expect(Number(lines[0].unitCost)).toBe(7.5);
  });

  it("refuses a part from another garage", async () => {
    const po = await draftPO(gA);
    const pB = await part(gB, "B1");
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(addPoLineAction, form({ poId: po.id, partId: pB.id, qty: "1", unitCost: "1" }));
    expect((await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } })).length).toBe(0);
  });

  it("cannot add a line to another garage's PO", async () => {
    const poB = await draftPO(gB);
    const pA = await part(gA, "A2");
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(addPoLineAction, form({ poId: poB.id, partId: pA.id, qty: "1", unitCost: "1" }));
    expect((await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: poB.id } })).length).toBe(0);
  });

  it("rejects qty <= 0", async () => {
    const po = await draftPO(gA);
    const p = await part(gA, "A3");
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(addPoLineAction, form({ poId: po.id, partId: p.id, qty: "0", unitCost: "1" }));
    expect(to).toContain("error=");
    expect((await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } })).length).toBe(0);
  });
});

describe("setPoStatusAction", { retry: 3 }, () => {
  it("won't mark ORDERED without any line", async () => {
    const po = await draftPO(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(setPoStatusAction, form({ poId: po.id, status: "ORDERED" }));
    expect(to).toContain("error=");
    expect((await prisma.purchaseOrder.findUnique({ where: { id: po.id } }))?.status).toBe("DRAFT");
  });

  it("marks ORDERED once a line exists, stamping orderedAt", async () => {
    const po = await draftPO(gA);
    const p = await part(gA, "A4");
    await prisma.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, partId: p.id, qty: 2, unitCost: "3" } });
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(setPoStatusAction, form({ poId: po.id, status: "ORDERED" }));
    const row = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(row?.status).toBe("ORDERED");
    expect(row?.orderedAt).not.toBeNull();
  });

  it("cancels a draft", async () => {
    const po = await draftPO(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(setPoStatusAction, form({ poId: po.id, status: "CANCELLED" }));
    expect((await prisma.purchaseOrder.findUnique({ where: { id: po.id } }))?.status).toBe("CANCELLED");
  });

  it("cannot change another garage's PO", async () => {
    const poB = await draftPO(gB);
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(setPoStatusAction, form({ poId: poB.id, status: "CANCELLED" }));
    expect((await prisma.purchaseOrder.findUnique({ where: { id: poB.id } }))?.status).toBe("DRAFT");
  });

  it("removePoLineAction removes a line on a draft (scoped)", async () => {
    const po = await draftPO(gA);
    const p = await part(gA, "A5");
    const line = await prisma.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, partId: p.id, qty: 1, unitCost: "1" } });
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(removePoLineAction, form({ poId: po.id, lineId: line.id }));
    expect((await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } })).length).toBe(0);
  });
});
