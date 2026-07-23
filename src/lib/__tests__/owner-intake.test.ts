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
