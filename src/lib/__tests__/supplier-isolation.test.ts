/**
 * Inventory 1c — tenant-isolation + permission tests for the supplier
 * directory. Proves:
 *   1. createSupplierAction writes to the CALLER'S garage (garageId from
 *      session, never from form input).
 *   2. A supplier created by garage A is invisible to / uneditable by
 *      garage B.
 *   3. Only OWNER can create / edit / (de)activate suppliers.
 *   4. Deactivate is SOFT — the row survives, active flips to false.
 *   5. The optional Part→Supplier link only accepts a supplier from the
 *      caller's own garage; a foreign supplier id is dropped (null).
 *
 * Cleanup is BY GARAGE-ID PREFIX so a crashed run can't leak rows.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { mockSessionAndSeed } from "@/lib/__tests__/helpers/mock-session-and-seed";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { createSupplierAction, updateSupplierAction, setSupplierActiveAction } =
  await import("@/app/actions/suppliers");
const { updatePartAction } = await import("@/app/actions/inventory");

const TEST_PREFIX = "sup-iso-test-";
const garageA = TEST_PREFIX + "garage-A";
const garageB = TEST_PREFIX + "garage-B";

async function ownerSession(garageId: string) {
  return mockSessionAndSeed({
    id: TEST_PREFIX + "u-owner-" + garageId,
    garageId,
    role: "OWNER",
  });
}
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function callAction(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<string> {
  try {
    await action(fd);
    return "(no redirect)";
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("REDIRECT:")) return m.slice("REDIRECT:".length);
    throw e; // a real error (e.g. "Not authorized")
  }
}

async function seedSupplier(garageId: string, over: Partial<{ name: string; active: boolean }> = {}) {
  return prisma.supplier.create({
    data: {
      garageId,
      name: over.name ?? "Seed Supplier",
      active: over.active ?? true,
    },
  });
}

async function cleanup() {
  // Part → Supplier is ON DELETE SET NULL, but delete parts first anyway
  // (they hang off the test garages). Movements FK to Part.
  await prisma.partMovement.deleteMany({
    where: { part: { garageId: { startsWith: TEST_PREFIX } } },
  });
  await prisma.part.deleteMany({ where: { garageId: { startsWith: TEST_PREFIX } } });
  await prisma.supplier.deleteMany({ where: { garageId: { startsWith: TEST_PREFIX } } });
  // Users FK to Garage — delete before garages.
  await prisma.user.deleteMany({ where: { garageId: { startsWith: TEST_PREFIX } } });
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

describe("createSupplierAction — isolation + permissions", { retry: 3 }, () => {
  it("creates the supplier in the caller's garage, scoped to it", async () => {
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    const to = await callAction(
      createSupplierAction,
      form({ name: "Al Futtaim Parts", contactPerson: "Sara", phone: "050", email: "s@x.com", trn: "100", address: "Deira" })
    );
    expect(to).toBe("/owner/suppliers");
    const inA = await prisma.supplier.findMany({ where: { garageId: garageA } });
    const inB = await prisma.supplier.findMany({ where: { garageId: garageB } });
    expect(inA.length).toBe(1);
    expect(inA[0].name).toBe("Al Futtaim Parts");
    expect(inA[0].contactPerson).toBe("Sara");
    expect(inA[0].active).toBe(true);
    expect(inB.length).toBe(0);
  });

  it("ignores a garageId smuggled in the form — uses the session's garage", async () => {
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    await callAction(createSupplierAction, form({ garageId: garageB, name: "Hack Supplier" }));
    expect((await prisma.supplier.findMany({ where: { garageId: garageB } })).length).toBe(0);
    expect((await prisma.supplier.findMany({ where: { garageId: garageA } })).length).toBe(1);
  });

  it("requires a name", async () => {
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    const to = await callAction(createSupplierAction, form({ name: "  " }));
    expect(to).toContain("/owner/suppliers?error=");
    expect((await prisma.supplier.findMany({ where: { garageId: garageA } })).length).toBe(0);
  });

  it("rejects a malformed email", async () => {
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    const to = await callAction(createSupplierAction, form({ name: "X", email: "not-an-email" }));
    expect(to).toContain("?error=");
    expect((await prisma.supplier.findMany({ where: { garageId: garageA } })).length).toBe(0);
  });

  it.each([["ADVISOR"], ["TECH"], ["CASHIER"]])(
    "rejects %s (only OWNER can create suppliers)",
    async (role) => {
      mockAuth.mockResolvedValueOnce({ user: { id: "x", role, garageId: garageA, email: "x", name: "x" } });
      await expect(createSupplierAction(form({ name: "Y" }))).rejects.toThrow("Not authorized");
      expect((await prisma.supplier.findMany({ where: { garageId: garageA } })).length).toBe(0);
    }
  );
});

describe("updateSupplierAction — isolation", { retry: 3 }, () => {
  it("edits a supplier in the caller's garage", async () => {
    const s = await seedSupplier(garageA, { name: "Old" });
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    const to = await callAction(updateSupplierAction, form({ supplierId: s.id, name: "New", phone: "052" }));
    expect(to).toBe(`/owner/suppliers/${s.id}`);
    const row = await prisma.supplier.findUnique({ where: { id: s.id } });
    expect(row?.name).toBe("New");
    expect(row?.phone).toBe("052");
  });

  it("cannot edit another garage's supplier", async () => {
    const sB = await seedSupplier(garageB, { name: "B-Supplier" });
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    const to = await callAction(updateSupplierAction, form({ supplierId: sB.id, name: "HACKED" }));
    expect(to).toContain("/owner/suppliers?error="); // "Supplier not found"
    expect((await prisma.supplier.findUnique({ where: { id: sB.id } }))?.name).toBe("B-Supplier");
  });

  it("rejects a non-owner", async () => {
    const s = await seedSupplier(garageA);
    mockAuth.mockResolvedValueOnce({ user: { id: "x", role: "ADVISOR", garageId: garageA, email: "x", name: "x" } });
    await expect(updateSupplierAction(form({ supplierId: s.id, name: "Y" }))).rejects.toThrow("Not authorized");
  });
});

describe("setSupplierActiveAction — soft delete", { retry: 3 }, () => {
  it("deactivates then restores (row survives)", async () => {
    const s = await seedSupplier(garageA, { active: true });
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    await callAction(setSupplierActiveAction, form({ supplierId: s.id, active: "false" }));
    let row = await prisma.supplier.findUnique({ where: { id: s.id } });
    expect(row).not.toBeNull(); // NOT hard-deleted
    expect(row?.active).toBe(false);

    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    await callAction(setSupplierActiveAction, form({ supplierId: s.id, active: "true" }));
    row = await prisma.supplier.findUnique({ where: { id: s.id } });
    expect(row?.active).toBe(true);
  });

  it("cannot deactivate another garage's supplier", async () => {
    const sB = await seedSupplier(garageB, { active: true });
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    await callAction(setSupplierActiveAction, form({ supplierId: sB.id, active: "false" }));
    expect((await prisma.supplier.findUnique({ where: { id: sB.id } }))?.active).toBe(true); // untouched
  });

  it("rejects a non-owner", async () => {
    const s = await seedSupplier(garageA);
    mockAuth.mockResolvedValueOnce({ user: { id: "x", role: "TECH", garageId: garageA, email: "x", name: "x" } });
    await expect(setSupplierActiveAction(form({ supplierId: s.id, active: "false" }))).rejects.toThrow("Not authorized");
  });
});

describe("part→supplier optional link — cross-tenant guard", { retry: 3 }, () => {
  async function seedPart(garageId: string) {
    return prisma.part.create({
      data: { garageId, sku: "LINK-1", name: "Linkable", cost: "1", price: "2" },
    });
  }

  it("links a supplier from the caller's own garage", async () => {
    const p = await seedPart(garageA);
    const s = await seedSupplier(garageA);
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    await callAction(updatePartAction, form({ partId: p.id, sku: "LINK-1", name: "Linkable", cost: "1", price: "2", supplierId: s.id }));
    expect((await prisma.part.findUnique({ where: { id: p.id } }))?.supplierId).toBe(s.id);
  });

  it("drops a foreign supplier id (does not link across tenants)", async () => {
    const p = await seedPart(garageA);
    const sB = await seedSupplier(garageB); // supplier in the OTHER garage
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    await callAction(updatePartAction, form({ partId: p.id, sku: "LINK-1", name: "Linkable", cost: "1", price: "2", supplierId: sB.id }));
    expect((await prisma.part.findUnique({ where: { id: p.id } }))?.supplierId).toBeNull();
  });

  it("clears the link when supplierId is blank", async () => {
    const s = await seedSupplier(garageA);
    const p = await prisma.part.create({
      data: { garageId: garageA, sku: "LINK-2", name: "Prelinked", cost: "1", price: "2", supplierId: s.id },
    });
    mockAuth.mockResolvedValueOnce(await ownerSession(garageA));
    await callAction(updatePartAction, form({ partId: p.id, sku: "LINK-2", name: "Prelinked", cost: "1", price: "2", supplierId: "" }));
    expect((await prisma.part.findUnique({ where: { id: p.id } }))?.supplierId).toBeNull();
  });
});
