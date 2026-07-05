/**
 * Inventory 1d — owner-dashboard low-stock metrics. Proves:
 *   1. inventoryHealth counts low = qtyOnHand <= that part's OWN
 *      reorderLevel (not a hardcoded 5), ACTIVE parts only.
 *   2. lowStockParts returns the actual low parts, most-urgent first
 *      (biggest shortfall), capped at the limit, with the full low count.
 *   3. Both are garage-scoped — garage B's parts never leak into A.
 *
 * These call the metric functions directly (no auth) with a garageId,
 * mirroring how the owner dashboard invokes them. Cleanup by id prefix.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { inventoryHealth, lowStockParts } from "@/lib/owner-metrics";

const P = "lowstock-test-";
const gA = P + "garage-A";
const gB = P + "garage-B";

async function part(
  garageId: string,
  sku: string,
  qtyOnHand: number,
  reorderLevel: number,
  active = true,
) {
  return prisma.part.create({
    data: { garageId, sku, name: `Part ${sku}`, cost: "1", price: "2", qtyOnHand, reorderLevel, active },
  });
}

async function cleanup() {
  await prisma.partMovement.deleteMany({ where: { part: { garageId: { startsWith: P } } } });
  await prisma.part.deleteMany({ where: { garageId: { startsWith: P } } });
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

describe("inventoryHealth — per-part reorderLevel, active only", { retry: 3 }, () => {
  it("uses each part's own reorder level, not a hardcoded 5", async () => {
    await part(gA, "LOW", 6, 10); // 6 <= 10 → low (old hardcoded 5 would MISS this)
    await part(gA, "OK", 6, 5); //  6 >  5  → not low
    await part(gA, "EDGE", 5, 5); // 5 <= 5 → low (at reorder level counts)
    const h = await inventoryHealth(gA);
    expect(h.total).toBe(3);
    expect(h.low).toBe(2); // LOW + EDGE
  });

  it("ignores discontinued (inactive) parts", async () => {
    await part(gA, "ACT", 0, 5); // active, low
    await part(gA, "GONE", 0, 5, false); // inactive → excluded from both counts
    const h = await inventoryHealth(gA);
    expect(h.total).toBe(1);
    expect(h.low).toBe(1);
  });

  it("is garage-scoped", async () => {
    await part(gA, "A1", 1, 5); // low in A
    await part(gB, "B1", 1, 5); // low in B
    expect((await inventoryHealth(gA)).low).toBe(1);
    expect((await inventoryHealth(gB)).low).toBe(1);
  });
});

describe("lowStockParts — reorder shortlist", { retry: 3 }, () => {
  it("returns low parts most-urgent (biggest shortfall) first, capped", async () => {
    await part(gA, "MILD", 4, 5); //  shortfall 1
    await part(gA, "BAD", 0, 10); //  shortfall 10 → most urgent
    await part(gA, "MID", 2, 6); //   shortfall 4
    await part(gA, "FINE", 20, 5); // not low
    const r = await lowStockParts(gA, 2);
    expect(r.low).toBe(3); // three below reorder
    expect(r.items.map((p) => p.sku)).toEqual(["BAD", "MID"]); // top 2 by shortfall
  });

  it("returns an empty list + zero when nothing is low", async () => {
    await part(gA, "OK1", 50, 5);
    const r = await lowStockParts(gA);
    expect(r.low).toBe(0);
    expect(r.items).toEqual([]);
  });

  it("does not leak another garage's low parts", async () => {
    await part(gB, "BLEAK", 0, 5);
    const r = await lowStockParts(gA);
    expect(r.low).toBe(0);
    expect(r.items).toEqual([]);
  });
});
