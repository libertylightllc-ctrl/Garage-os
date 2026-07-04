/**
 * Inventory Phase 1 — tenant-isolation + permission tests for the parts
 * catalog. Proves:
 *   1. createPartAction writes the part to the CALLER'S garage (garageId
 *      from session, never from form input — even if the form smuggles a
 *      garageId, it's ignored).
 *   2. A part created by garage A is not visible to garage B.
 *   3. Only OWNER can create parts (ADVISOR/TECH/CASHIER rejected).
 *   4. Duplicate SKU within a garage is refused.
 *
 * Cleanup is BY ID PREFIX so a crashed run can't leak rows.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

// revalidatePath is a no-op in tests.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// redirect() throws NEXT_REDIRECT in Next; replace with a catchable
// sentinel carrying the target URL so we can assert success vs error.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { createPartAction, updatePartAction, adjustStockAction } = await import(
  "@/app/actions/inventory"
);

const TEST_PREFIX = "inv-iso-test-";
const garageA = TEST_PREFIX + "garage-A";
const garageB = TEST_PREFIX + "garage-B";

function ownerSession(garageId: string) {
  return { user: { id: TEST_PREFIX + "u", role: "OWNER", garageId, email: "x", name: "x" } };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Call the action, capturing the redirect target instead of throwing out. */
async function callCreate(fd: FormData): Promise<string> {
  try {
    await createPartAction(fd);
    return "(no redirect)";
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("REDIRECT:")) return m.slice("REDIRECT:".length);
    throw e; // a real error (e.g. "Not authorized")
  }
}

async function cleanup() {
  // Movements FK to Part — delete them first (adjustStockAction writes them).
  await prisma.partMovement.deleteMany({
    where: { part: { garageId: { startsWith: TEST_PREFIX } } },
  });
  await prisma.part.deleteMany({ where: { garageId: { startsWith: TEST_PREFIX } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: TEST_PREFIX } } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: garageA, name: TEST_PREFIX + "A" } });
  await prisma.garage.create({ data: { id: garageB, name: TEST_PREFIX + "B" } });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// retry: the Prisma pg-adapter prepared-statement cache occasionally
// races under full parallel test load (a query returns a stale/empty
// result). Same mitigation as admin-isolation / login-lockout suites.
// Passes 7/7 standalone; retry absorbs the parallel-run flake.
describe("createPartAction — tenant isolation + permissions", { retry: 3 }, () => {
  it("creates the part in the caller's garage and is scoped to it", async () => {
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    const to = await callCreate(
      form({ sku: "BRK-01", name: "Brake pad", cost: "20", price: "45", qtyOnHand: "10", reorderLevel: "3" })
    );
    expect(to).toBe("/owner/inventory"); // success redirect

    const inA = await prisma.part.findMany({ where: { garageId: garageA } });
    const inB = await prisma.part.findMany({ where: { garageId: garageB } });
    expect(inA.length).toBe(1);
    expect(inA[0].sku).toBe("BRK-01");
    expect(inA[0].qtyOnHand).toBe(10);
    expect(inA[0].reorderLevel).toBe(3);
    expect(inB.length).toBe(0); // garage B cannot see garage A's part
  });

  it("ignores a garageId smuggled in the form — uses the session's garage", async () => {
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    // Attacker owner-of-A tries to create a part in garage B via a form field.
    await callCreate(
      form({ garageId: garageB, sku: "HACK-01", name: "x", cost: "1", price: "1" })
    );
    const inB = await prisma.part.findMany({ where: { garageId: garageB } });
    const inA = await prisma.part.findMany({ where: { garageId: garageA } });
    expect(inB.length).toBe(0); // did NOT land in B
    expect(inA.length).toBe(1); // landed in the caller's own garage
  });

  it.each([["ADVISOR"], ["TECH"], ["CASHIER"]])(
    "rejects %s (only OWNER can create parts)",
    async (role) => {
      mockAuth.mockResolvedValueOnce({ user: { id: "x", role, garageId: garageA, email: "x", name: "x" } });
      await expect(
        createPartAction(form({ sku: "X", name: "Y", cost: "1", price: "1" }))
      ).rejects.toThrow("Not authorized");
      const inA = await prisma.part.findMany({ where: { garageId: garageA } });
      expect(inA.length).toBe(0);
    }
  );

  it("refuses a duplicate SKU within the same garage", async () => {
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    await callCreate(form({ sku: "DUP-1", name: "First", cost: "1", price: "2" }));
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    const to = await callCreate(form({ sku: "DUP-1", name: "Second", cost: "1", price: "2" }));
    expect(to).toContain("/owner/inventory?error="); // error redirect
    const inA = await prisma.part.findMany({ where: { garageId: garageA } });
    expect(inA.length).toBe(1); // still only one
  });

  it("allows the SAME SKU in two different garages (per-garage uniqueness)", async () => {
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    await callCreate(form({ sku: "SAME", name: "A part", cost: "1", price: "2" }));
    mockAuth.mockResolvedValueOnce(ownerSession(garageB));
    const to = await callCreate(form({ sku: "SAME", name: "B part", cost: "1", price: "2" }));
    expect(to).toBe("/owner/inventory"); // success — not a clash across garages
    expect((await prisma.part.findMany({ where: { garageId: garageA } })).length).toBe(1);
    expect((await prisma.part.findMany({ where: { garageId: garageB } })).length).toBe(1);
  });
});

// ---- 1b: edit + manual stock adjustment ----

async function seedPart(garageId: string, over: Partial<{ sku: string; qtyOnHand: number; reorderLevel: number }> = {}) {
  return prisma.part.create({
    data: {
      garageId,
      sku: over.sku ?? "SEED-1",
      name: "Seed Part",
      cost: "10",
      price: "20",
      qtyOnHand: over.qtyOnHand ?? 5,
      reorderLevel: over.reorderLevel ?? 3,
    },
  });
}

async function callAction(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<string> {
  try {
    await action(fd);
    return "(no redirect)";
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("REDIRECT:")) return m.slice("REDIRECT:".length);
    throw e;
  }
}

describe("updatePartAction — 1b edit", { retry: 3 }, () => {
  it("edits a part in the caller's garage", async () => {
    const p = await seedPart(garageA, { sku: "OLD" });
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    const to = await callAction(updatePartAction, form({ partId: p.id, sku: "NEW", name: "Renamed", cost: "12", price: "25", reorderLevel: "7" }));
    expect(to).toBe(`/owner/inventory/${p.id}`);
    const row = await prisma.part.findUnique({ where: { id: p.id } });
    expect(row?.sku).toBe("NEW");
    expect(row?.name).toBe("Renamed");
    expect(row?.reorderLevel).toBe(7);
    expect(Number(row?.price)).toBe(25);
  });

  it("cannot edit another garage's part", async () => {
    const pB = await seedPart(garageB, { sku: "B-PART" });
    mockAuth.mockResolvedValueOnce(ownerSession(garageA)); // A tries to edit B's part
    const to = await callAction(updatePartAction, form({ partId: pB.id, sku: "HACKED", name: "x", cost: "1", price: "1" }));
    expect(to).toContain("/owner/inventory?error="); // "Part not found"
    const row = await prisma.part.findUnique({ where: { id: pB.id } });
    expect(row?.sku).toBe("B-PART"); // unchanged
  });

  it("rejects a non-owner", async () => {
    const p = await seedPart(garageA);
    mockAuth.mockResolvedValueOnce({ user: { id: "x", role: "ADVISOR", garageId: garageA, email: "x", name: "x" } });
    await expect(updatePartAction(form({ partId: p.id, sku: "X", name: "Y", cost: "1", price: "1" }))).rejects.toThrow("Not authorized");
  });
});

describe("adjustStockAction — 1b manual adjustment", { retry: 3 }, () => {
  it("adds stock, records a movement, and updates qty", async () => {
    const p = await seedPart(garageA, { qtyOnHand: 5 });
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    const to = await callAction(adjustStockAction, form({ partId: p.id, direction: "add", qty: "8", reason: "received" }));
    expect(to).toBe(`/owner/inventory/${p.id}`);
    const row = await prisma.part.findUnique({ where: { id: p.id } });
    expect(row?.qtyOnHand).toBe(13);
    const moves = await prisma.partMovement.findMany({ where: { partId: p.id } });
    expect(moves.length).toBe(1);
    expect(moves[0].delta).toBe(8);
    expect(moves[0].reason).toBe("received");
  });

  it("removes stock (negative delta) and records it", async () => {
    const p = await seedPart(garageA, { qtyOnHand: 5 });
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    await callAction(adjustStockAction, form({ partId: p.id, direction: "remove", qty: "2", reason: "damaged" }));
    const row = await prisma.part.findUnique({ where: { id: p.id } });
    expect(row?.qtyOnHand).toBe(3);
    const moves = await prisma.partMovement.findMany({ where: { partId: p.id } });
    expect(moves[0].delta).toBe(-2);
    expect(moves[0].reason).toBe("damaged");
  });

  it("refuses to drive stock negative", async () => {
    const p = await seedPart(garageA, { qtyOnHand: 3 });
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    const to = await callAction(adjustStockAction, form({ partId: p.id, direction: "remove", qty: "10", reason: "x" }));
    expect(to).toContain("/owner/inventory/" + p.id + "?error=");
    const row = await prisma.part.findUnique({ where: { id: p.id } });
    expect(row?.qtyOnHand).toBe(3); // unchanged
    expect((await prisma.partMovement.findMany({ where: { partId: p.id } })).length).toBe(0); // no movement written
  });

  it("requires a reason", async () => {
    const p = await seedPart(garageA, { qtyOnHand: 5 });
    mockAuth.mockResolvedValueOnce(ownerSession(garageA));
    const to = await callAction(adjustStockAction, form({ partId: p.id, direction: "add", qty: "1", reason: "" }));
    expect(to).toContain("?error=");
    expect((await prisma.part.findUnique({ where: { id: p.id } }))?.qtyOnHand).toBe(5); // unchanged
  });

  it("cannot adjust another garage's part", async () => {
    const pB = await seedPart(garageB, { qtyOnHand: 5 });
    mockAuth.mockResolvedValueOnce(ownerSession(garageA)); // A tries to adjust B's part
    await callAction(adjustStockAction, form({ partId: pB.id, direction: "add", qty: "99", reason: "hack" }));
    const row = await prisma.part.findUnique({ where: { id: pB.id } });
    expect(row?.qtyOnHand).toBe(5); // untouched
    expect((await prisma.partMovement.findMany({ where: { partId: pB.id } })).length).toBe(0);
  });

  it("rejects a non-owner", async () => {
    const p = await seedPart(garageA);
    mockAuth.mockResolvedValueOnce({ user: { id: "x", role: "TECH", garageId: garageA, email: "x", name: "x" } });
    await expect(adjustStockAction(form({ partId: p.id, direction: "add", qty: "1", reason: "x" }))).rejects.toThrow("Not authorized");
  });
});
