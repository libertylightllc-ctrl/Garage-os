/**
 * Tech Hours Lookup — isolation + guard tests.
 *
 * Proves:
 * 1. The tech picker query scopes to a SINGLE garage (not cross-branch).
 * 2. techDailyHistory scoped to [garageId] returns only that garage's sessions.
 * 3. Another garage's tech/session is invisible.
 */

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { techDailyHistory } from "@/lib/work-session-reports";

const P = "hrs-lookup-test-";

let garageA: string;
let garageB: string;
let techA: string;
let techB: string;
let jobA: string;
let jobB: string;
let custA: string;
let custB: string;
let vehA: string;
let vehB: string;

async function cleanup() {
  await prisma.workSession.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.jobCard.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.customer.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
  await cleanup();

  garageA = P + "garage-a";
  garageB = P + "garage-b";
  techA = P + "tech-a";
  techB = P + "tech-b";
  custA = P + "cust-a";
  custB = P + "cust-b";
  vehA = P + "veh-a";
  vehB = P + "veh-b";
  jobA = P + "job-a";
  jobB = P + "job-b";

  await prisma.garage.createMany({
    data: [
      { id: garageA, name: "Garage A" },
      { id: garageB, name: "Garage B" },
    ],
  });

  await prisma.user.createMany({
    data: [
      { id: techA, name: "Tech A", email: P + "ta@test", garageId: garageA, role: "TECH", passwordHash: "x" },
      { id: techB, name: "Tech B", email: P + "tb@test", garageId: garageB, role: "TECH", passwordHash: "x" },
    ],
  });

  await prisma.customer.createMany({
    data: [
      { id: custA, name: "Cust A", phone: "0501", garageId: garageA },
      { id: custB, name: "Cust B", phone: "0502", garageId: garageB },
    ],
  });

  await prisma.vehicle.createMany({
    data: [
      { id: vehA, plate: "A 111", make: "Toyota", model: "Camry", year: 2020, customerId: custA },
      { id: vehB, plate: "B 222", make: "Nissan", model: "Patrol", year: 2021, customerId: custB },
    ],
  });

  await prisma.jobCard.createMany({
    data: [
      { id: jobA, vehicleId: vehA, garageId: garageA, status: "REPAIR" },
      { id: jobB, vehicleId: vehB, garageId: garageB, status: "REPAIR" },
    ],
  });

  const now = new Date();
  await prisma.workSession.createMany({
    data: [
      { id: P + "ws-a", techId: techA, jobCardId: jobA, garageId: garageA, startedAt: new Date(now.getTime() - 60 * 60_000), endedAt: now, endReason: "DONE" },
      { id: P + "ws-b", techId: techB, jobCardId: jobB, garageId: garageB, startedAt: new Date(now.getTime() - 30 * 60_000), endedAt: now, endReason: "DONE" },
    ],
  });
});

afterAll(async () => {
  await cleanup();
});

describe("Tech Hours Lookup — garage isolation", () => {
  it("tech picker query scoped to single garage returns only that garage's techs", async () => {
    const techs = await prisma.user.findMany({
      where: { garageId: garageA, role: { in: ["TECH", "MASTER"] } },
      select: { id: true, name: true },
    });
    expect(techs).toHaveLength(1);
    expect(techs[0].id).toBe(techA);
  });

  it("another garage's tech is invisible to garage A's query", async () => {
    const techs = await prisma.user.findMany({
      where: { garageId: garageA, role: { in: ["TECH", "MASTER"] } },
      select: { id: true },
    });
    const ids = techs.map((t) => t.id);
    expect(ids).not.toContain(techB);
  });

  it("techDailyHistory scoped to [garageA] returns only garage A's sessions", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 86_400_000);
    const result = await techDailyHistory(techA, [garageA], { from, to: now });
    expect(result.totalMin).toBeGreaterThan(0);
    expect(result.totalCars).toBe(1);
    expect(result.days[0].cars[0].vehicleMake).toBe("Toyota");
  });

  it("techDailyHistory with garage B's id does not expose garage A's sessions", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 86_400_000);
    const result = await techDailyHistory(techA, [garageB], { from, to: now });
    expect(result.totalMin).toBe(0);
    expect(result.days).toHaveLength(0);
  });

  it("tech B in garage B is invisible when querying garage A", async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 86_400_000);
    const result = await techDailyHistory(techB, [garageA], { from, to: now });
    expect(result.totalMin).toBe(0);
    expect(result.days).toHaveLength(0);
  });
});
