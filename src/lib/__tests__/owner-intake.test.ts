/**
 * HOTFIX — prod incident ref 3426515655 (/advisor/jobs/new/confirm?via=manual).
 *
 * The solo-owner slice widened the intake PAGES to OWNER but missed the two
 * action files with their own strict requireAdvisor():
 *   - intake-moulkia.ts → createCustomerVehicleJobAction (the reception form
 *     submit — Moulkia, manual, and repeat paths all land here)
 *   - intake.ts → confirmBookingAction / rejectBookingAction
 * An OWNER could open the form but the submit threw "Not authorized" →
 * the generic error screen the shop saw.
 *
 *   1. OWNER submits the reception form → job + customer + vehicle created.
 *   2. ADVISOR path byte-identical (regression guard).
 *   3. TECH / CASHIER still rejected (nothing over-opened).
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

const { createCustomerVehicleJobAction } = await import("@/app/actions/intake-moulkia");

const P = "owner-intake-test-";
const gA = P + "garage-A";

const as = (role: string) => ({
  user: { id: P + "u-" + role.toLowerCase(), role, garageId: gA, email: "x", name: "x" },
});
function receptionForm(): FormData {
  const fd = new FormData();
  fd.set("via", "manual");
  fd.set("ownerName", "Hassan M.");
  fd.set("phone", P + Math.random().toString().slice(2, 10));
  fd.set("plate", "H-" + Math.random().toString(36).slice(2, 8));
  fd.set("make", "Nissan");
  fd.set("model", "Patrol");
  fd.set("mileageIn", "84000");
  fd.set("complaint", "AC not cooling");
  return fd;
}
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
  for (const role of ["OWNER", "ADVISOR", "TECH", "CASHIER"]) {
    const id = P + "u-" + role.toLowerCase();
    await prisma.user.upsert({
      where: { id },
      update: {},
      create: { id, garageId: gA, role: role as never, name: role, email: id + "@test.local" },
    });
  }
}

async function cleanup() {
  await prisma.jobStep.deleteMany({ where: { jobCard: { garageId: { startsWith: P } } } });
  await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: { startsWith: P } } } });
  await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.bay.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
  await cleanup();
  await setup();
  mockAuth.mockReset();
});
afterAll(cleanup);

describe("hotfix — owner can submit the reception form", () => {
  it("OWNER creates job + customer + vehicle via manual intake (the prod failure)", async () => {
    mockAuth.mockResolvedValue(as("OWNER"));
    const to = await call(createCustomerVehicleJobAction, receptionForm());
    expect(to).toMatch(/\/advisor\/jobs\//); // redirected to the new job
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(1);
  });

  it("ADVISOR path unchanged", async () => {
    mockAuth.mockResolvedValue(as("ADVISOR"));
    const to = await call(createCustomerVehicleJobAction, receptionForm());
    expect(to).toMatch(/\/advisor\/jobs\//);
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(1);
  });

  it("blank priority/tech/bay land as defaults (0 / null / null)", async () => {
    // The regression guard: leaving the new intake pickers untouched
    // must behave exactly as it did before they existed — priority 0,
    // no assigned tech, no bay. If this fails, the blank case broke.
    mockAuth.mockResolvedValue(as("OWNER"));
    await call(createCustomerVehicleJobAction, receptionForm());
    const job = await prisma.jobCard.findFirst({ where: { garageId: gA } });
    expect(job?.priority).toBe(0);
    expect(job?.assignedToId).toBeNull();
    expect(job?.bayId).toBeNull();
  });

  it("priority + tech + bay are persisted when set at intake", async () => {
    mockAuth.mockResolvedValue(as("OWNER"));
    const techId = P + "u-tech"; // seeded by setup()
    const bay = await prisma.bay.create({
      data: { garageId: gA, name: "Bay-" + Math.random().toString(36).slice(2, 6) },
      select: { id: true },
    });
    const fd = receptionForm();
    fd.set("priority", "1");
    fd.set("assignedToId", techId);
    fd.set("bayId", bay.id);
    await call(createCustomerVehicleJobAction, fd);
    const job = await prisma.jobCard.findFirst({ where: { garageId: gA } });
    expect(job?.priority).toBe(1);
    expect(job?.assignedToId).toBe(techId);
    expect(job?.bayId).toBe(bay.id);
  });

  it("bogus tech / bay IDs resolve to null (no cross-garage leak)", async () => {
    mockAuth.mockResolvedValue(as("OWNER"));
    const fd = receptionForm();
    fd.set("assignedToId", "does-not-exist");
    fd.set("bayId", "does-not-exist");
    await call(createCustomerVehicleJobAction, fd);
    const job = await prisma.jobCard.findFirst({ where: { garageId: gA } });
    expect(job?.assignedToId).toBeNull();
    expect(job?.bayId).toBeNull();
  });

  it("TECH and CASHIER still rejected", async () => {
    for (const role of ["TECH", "CASHIER"]) {
      mockAuth.mockResolvedValue(as(role));
      await expect(call(createCustomerVehicleJobAction, receptionForm())).rejects.toThrow(
        /Not authorized/,
      );
    }
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(0);
  });
});

// Pre-flight branching added 2026-07-30 to close the silent-duplicate
// vector: Vehicle has no @@unique on (garageId, plate) at the schema
// level, so a naive intake with a colliding plate would create a second
// Vehicle row rather than crash. See docs/intake-duplicate-handling-spec.md.
describe("intake action — pre-flight branching (Cases A / B / C / default)", () => {
  it("Case A implicit — same customer + same plate → new JobCard on existing Vehicle, no duplicate rows", async () => {
    mockAuth.mockResolvedValue(as("ADVISOR"));
    // First intake writes the identity.
    const first = receptionForm();
    const phone = String(first.get("phone"));
    const plate = String(first.get("plate"));
    await call(createCustomerVehicleJobAction, first);

    const custBefore = await prisma.customer.count({ where: { garageId: gA } });
    const vehBefore = await prisma.vehicle.count({ where: { customer: { garageId: gA } } });
    expect(custBefore).toBe(1);
    expect(vehBefore).toBe(1);

    // Second intake — same customer, same plate. Should reuse both.
    const second = receptionForm();
    second.set("phone", phone);
    second.set("plate", plate);
    await call(createCustomerVehicleJobAction, second);

    const custAfter = await prisma.customer.count({ where: { garageId: gA } });
    const vehAfter = await prisma.vehicle.count({ where: { customer: { garageId: gA } } });
    expect(custAfter).toBe(1); // still one
    expect(vehAfter).toBe(1); // still one
    // Two JobCards on the same Vehicle.
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(2);
  });

  it("Case B — same plate under a DIFFERENT customer → redirect, NO writes", async () => {
    mockAuth.mockResolvedValue(as("ADVISOR"));
    // Seed the first customer + car.
    const seed = receptionForm();
    const plate = String(seed.get("plate"));
    await call(createCustomerVehicleJobAction, seed);
    expect(await prisma.customer.count({ where: { garageId: gA } })).toBe(1);
    expect(await prisma.vehicle.count({ where: { customer: { garageId: gA } } })).toBe(1);
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(1);

    // Second intake: DIFFERENT phone but SAME plate → Case B.
    const collide = receptionForm();
    collide.set("plate", plate); // different customer randomizes phone

    const to = await call(createCustomerVehicleJobAction, collide);
    expect(to).toBe("/advisor/jobs/new?error=plate_belongs_to_another_customer");
    // Critical: NO writes happened. Counts unchanged.
    expect(await prisma.customer.count({ where: { garageId: gA } })).toBe(1);
    expect(await prisma.vehicle.count({ where: { customer: { garageId: gA } } })).toBe(1);
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(1);
  });

  it("Case C — existing customer, NEW plate → new Vehicle under existing Customer, no duplicate Customer", async () => {
    mockAuth.mockResolvedValue(as("ADVISOR"));
    const first = receptionForm();
    const phone = String(first.get("phone"));
    await call(createCustomerVehicleJobAction, first);

    // Same customer (same phone), different plate — second car for the
    // same person. Today's default upsert-on-phone branch handles this
    // correctly; the pre-flight leaves it untouched.
    const second = receptionForm();
    second.set("phone", phone);
    // second.plate stays randomized — different from first.
    await call(createCustomerVehicleJobAction, second);

    expect(await prisma.customer.count({ where: { garageId: gA } })).toBe(1); // still one
    expect(await prisma.vehicle.count({ where: { customer: { garageId: gA } } })).toBe(2); // both cars
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(2);
  });

  it("Default — fully new customer + plate → today's path (regression guard)", async () => {
    mockAuth.mockResolvedValue(as("ADVISOR"));
    await call(createCustomerVehicleJobAction, receptionForm());
    expect(await prisma.customer.count({ where: { garageId: gA } })).toBe(1);
    expect(await prisma.vehicle.count({ where: { customer: { garageId: gA } } })).toBe(1);
    expect(await prisma.jobCard.count({ where: { garageId: gA } })).toBe(1);
  });
});
