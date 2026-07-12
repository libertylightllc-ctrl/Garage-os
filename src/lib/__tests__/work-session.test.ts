/**
 * Tech-tracking slice 1 — WorkSession segments through the REAL actions.
 *
 * The scenarios AR specified before ship:
 *   1. Switch: claim car A → claim car B → A's segment auto-closed
 *      (SWITCHED), B's open, exactly ONE open session for the tech.
 *   2. Return: "I'm on this car" back on A → B closes, a NEW segment
 *      opens on A (per-car totals accumulate across switches).
 *   3. The tap is idempotent — tapping the car you're already on does
 *      not close/reopen anything.
 *   4. Hand-offs close the clock: send-for-estimate ends every open
 *      segment on the job; advisor HOLD does too.
 *   5. The DB itself refuses a second open session per tech (partial
 *      unique index) — belt and braces under racing taps.
 *   6. CRITICAL: a session-write failure does NOT block the claim. The
 *      claim CAS lands, the action returns normally, only the session
 *      is missing.
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

const { claimJobAction, startWorkAction, sendForEstimateAction, jobActionAction } =
  await import("@/app/actions/jobs");

const P = "work-session-test-";
const gA = P + "garage";
const TECH = P + "u-tech";
const jobA = P + "job-a";
const jobB = P + "job-b";

const as = (role: string, id: string) => ({
  user: { id, role, garageId: gA, email: "x", name: "x" },
});
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
/** Run an action; swallow redirect throws (they signal navigation, not failure). */
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
  for (const [id, role] of [
    [TECH, "TECH"],
    [P + "u-advisor", "ADVISOR"],
  ] as const) {
    await prisma.user.upsert({
      where: { id },
      update: {},
      create: { id, garageId: gA, role: role as never, name: id, email: id + "@test.local" },
    });
  }
  const cust = await prisma.customer.upsert({
    where: { id: P + "cust" },
    update: {},
    create: { id: P + "cust", garageId: gA, name: "WS Customer", phone: P + "555" },
  });
  const veh = await prisma.vehicle.upsert({
    where: { id: P + "veh" },
    update: {},
    create: { id: P + "veh", customerId: cust.id, plate: P + "PLT", make: "Toyota", model: "Hilux" },
  });
  for (const id of [jobA, jobB]) {
    await prisma.jobCard.upsert({
      where: { id },
      update: { status: "ARRIVED", claimedById: null, claimedAt: null },
      create: { id, garageId: gA, vehicleId: veh.id, status: "ARRIVED" },
    });
  }
}

async function cleanup() {
  await prisma.workSession.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.jobHelper.deleteMany({ where: { jobCard: { garageId: { startsWith: P } } } });
  await prisma.jobStep.deleteMany({ where: { jobCard: { garageId: { startsWith: P } } } });
  await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: { startsWith: P } } } });
  await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
  await cleanup();
  await setup();
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(as("TECH", TECH));
});
afterAll(cleanup);

const openFor = (techId: string) =>
  prisma.workSession.findMany({ where: { techId, endedAt: null } });

describe("work sessions through the real claim flow", () => {
  it("claim A → claim B: A auto-closes as SWITCHED, B open, ONE open per tech", async () => {
    await call(claimJobAction, form({ jobId: jobA }));
    let open = await openFor(TECH);
    expect(open).toHaveLength(1);
    expect(open[0].jobCardId).toBe(jobA);

    await call(claimJobAction, form({ jobId: jobB }));

    const aSessions = await prisma.workSession.findMany({ where: { jobCardId: jobA } });
    expect(aSessions).toHaveLength(1);
    expect(aSessions[0].endedAt).not.toBeNull();
    expect(aSessions[0].endReason).toBe("SWITCHED");

    open = await openFor(TECH);
    expect(open).toHaveLength(1); // exactly ONE open session
    expect(open[0].jobCardId).toBe(jobB);
  });

  it("returning to car A opens a NEW segment (totals accumulate across switches)", async () => {
    await call(claimJobAction, form({ jobId: jobA }));
    await call(claimJobAction, form({ jobId: jobB }));
    await call(startWorkAction, form({ jobId: jobA })); // one tap back on A

    const aSessions = await prisma.workSession.findMany({
      where: { jobCardId: jobA },
      orderBy: { startedAt: "asc" },
    });
    expect(aSessions).toHaveLength(2); // first closed, second live
    expect(aSessions[0].endReason).toBe("SWITCHED");
    expect(aSessions[1].endedAt).toBeNull();

    const bSessions = await prisma.workSession.findMany({ where: { jobCardId: jobB } });
    expect(bSessions).toHaveLength(1);
    expect(bSessions[0].endReason).toBe("SWITCHED");

    expect(await openFor(TECH)).toHaveLength(1);
  });

  it("tapping the car you're already on is a no-op (no close/reopen churn)", async () => {
    await call(claimJobAction, form({ jobId: jobA }));
    const before = await prisma.workSession.findFirst({ where: { techId: TECH, endedAt: null } });
    await call(startWorkAction, form({ jobId: jobA }));
    const after = await prisma.workSession.findMany({ where: { jobCardId: jobA } });
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before!.id); // same segment, untouched
  });

  it("send-for-estimate and advisor HOLD close every open segment on the job", async () => {
    await call(claimJobAction, form({ jobId: jobA }));
    await call(sendForEstimateAction, form({ jobId: jobA }));
    let s = await prisma.workSession.findFirst({ where: { jobCardId: jobA } });
    expect(s!.endedAt).not.toBeNull();
    expect(s!.endReason).toBe("SENT_FOR_ESTIMATE");

    // fresh claim on B, then the advisor puts B on hold
    await call(claimJobAction, form({ jobId: jobB }));
    mockAuth.mockResolvedValue(as("ADVISOR", P + "u-advisor"));
    await call(jobActionAction, form({ jobId: jobB, action: "HOLD", holdReason: "AWAITING_PART" }));
    s = await prisma.workSession.findFirst({ where: { jobCardId: jobB } });
    expect(s!.endedAt).not.toBeNull();
    expect(s!.endReason).toBe("JOB_CLOSED");
  });

  it("the DB refuses a second open session per tech (partial unique index)", async () => {
    await prisma.workSession.create({ data: { garageId: gA, jobCardId: jobA, techId: TECH } });
    await expect(
      prisma.workSession.create({ data: { garageId: gA, jobCardId: jobB, techId: TECH } }),
    ).rejects.toThrow(); // unique violation on WorkSession_one_open_per_tech
  });

  it("CRITICAL: a session-write failure does NOT block the claim", async () => {
    // Force the session transaction to blow up exactly once.
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await call(claimJobAction, form({ jobId: jobA })); // must NOT throw
      const job = await prisma.jobCard.findUnique({ where: { id: jobA } });
      expect(job!.claimedById).toBe(TECH); // the claim LANDED
      expect(job!.status).toBe("INSPECTION");
      expect(await openFor(TECH)).toHaveLength(0); // only the session is missing
      expect(errSpy).toHaveBeenCalled(); // and the failure was logged
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
