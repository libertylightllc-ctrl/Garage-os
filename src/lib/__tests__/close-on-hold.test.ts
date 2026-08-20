/**
 * Close-on-hold — AR 2026-08-20 Finding 2, second pillar.
 *
 * Before this pass, four ON_HOLD leak sites left the tech's open
 * WorkSession running while the job was paused: two in parts.ts
 * (part request in the tech flow + order in the advisor flow) and
 * two in billing.ts (extra-work approval pause during invoice
 * generation). The pause happened, the clock kept ticking, and
 * hours of wall time accrued as fake wrench-time against the
 * invoice — the mechanism behind INV-2026-0051 (200 revenue / 445
 * cost, -122.5% margin).
 *
 * Every hold-with-leak site is now paired with
 * closeJobSessions(jobId, "JOB_CLOSED"), matching the shape used
 * by markCompleteAction / sendForEstimateAction / cancelJobAction.
 * This test pins both parts sites (billing sites go through a
 * long approval chain that's covered by separate flow tests;
 * pinning the shape here is enough — the same one-line helper
 * fires in all four).
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

const { requestPartAction, orderPartRequestAction } = await import("@/app/actions/parts");
const { releaseJobAction, reassignJobAction } = await import("@/app/actions/jobs");

const P = "close-on-hold-test-";
const gid = P + "g1";
const techId = P + "tech";
const advisorId = P + "adv";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function cleanup() {
  await prisma.workSession.deleteMany({ where: { garageId: gid } });
  await prisma.jobStep.deleteMany({ where: { jobCard: { garageId: gid } } });
  await prisma.partMovement.deleteMany({ where: { garageId: gid } });
  await prisma.partRequest.deleteMany({ where: { garageId: gid } });
  await prisma.part.deleteMany({ where: { garageId: gid } });
  await prisma.jobCard.deleteMany({ where: { garageId: gid } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: gid } } });
  await prisma.customer.deleteMany({ where: { garageId: gid } });
  await prisma.user.deleteMany({ where: { garageId: gid } });
  await prisma.garage.deleteMany({ where: { id: gid } });
}

async function seedJobInRepair(opts: { claimedById?: string } = {}) {
  const customer = await prisma.customer.create({
    data: { garageId: gid, name: "C", phone: P + Math.random() },
  });
  const vehicle = await prisma.vehicle.create({
    data: { customerId: customer.id, make: "T", model: "C", plate: "P-" + Math.random().toString(36).slice(2, 8) },
  });
  const job = await prisma.jobCard.create({
    data: {
      garageId: gid,
      vehicleId: vehicle.id,
      status: "REPAIR",
      claimedById: opts.claimedById ?? techId,
      claimedAt: new Date(),
    },
  });
  // Open work session on the job — this is what should get closed.
  const session = await prisma.workSession.create({
    data: { garageId: gid, jobCardId: job.id, techId: opts.claimedById ?? techId },
  });
  return { job, session };
}

beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: gid, name: gid } });
  await mockSessionAndSeed({ id: techId, garageId: gid, role: "TECH" });
  await mockSessionAndSeed({ id: advisorId, garageId: gid, role: "ADVISOR" });
  mockAuth.mockReset();
});
afterAll(cleanup);

describe("close-on-hold — parts sites", () => {
  it("requestPartAction (OUT-OF-STOCK) — job pauses AND open session closes", async () => {
    const { job, session } = await seedJobInRepair();
    mockAuth.mockResolvedValue({ user: { id: techId, garageId: gid, role: "TECH", email: "x", name: "x" } });

    // Free-text out-of-stock request → auto-pause path.
    await requestPartAction(form({
      jobId: job.id,
      description: "Rare hydraulic seal",
      qty: "1",
      available: "false",
    }));

    // Job flipped to ON_HOLD / AWAITING_PART.
    const j = await prisma.jobCard.findUnique({ where: { id: job.id } });
    expect(j!.status).toBe("ON_HOLD");
    expect(j!.holdReason).toBe("AWAITING_PART");

    // Linchpin — the WorkSession that was open when the tech asked
    // for the part is now closed. Before this fix, the clock kept
    // running against the invoice.
    const s = await prisma.workSession.findUnique({ where: { id: session.id } });
    expect(s!.endedAt).not.toBeNull();
    expect(s!.endReason).toBe("JOB_CLOSED");
  });

  it("requestPartAction (IN-STOCK) — no pause, session stays open", async () => {
    // Contrast case: an in-stock request doesn't pause the job (the
    // tech will fit the part immediately), so the session should
    // NOT get closed. Guards the close from firing on the wrong
    // path.
    const { job, session } = await seedJobInRepair();
    // Seed a matching part so the request marks available.
    const part = await prisma.part.create({
      data: { garageId: gid, sku: "SEAL-01", name: "Seal", cost: "5", price: "10", qtyOnHand: 3 },
    });
    mockAuth.mockResolvedValue({ user: { id: techId, garageId: gid, role: "TECH", email: "x", name: "x" } });

    await requestPartAction(form({
      jobId: job.id,
      partId: part.id,
      description: "Seal",
      qty: "1",
      available: "true",
    }));

    const j = await prisma.jobCard.findUnique({ where: { id: job.id } });
    expect(j!.status).toBe("REPAIR"); // no pause
    const s = await prisma.workSession.findUnique({ where: { id: session.id } });
    expect(s!.endedAt).toBeNull(); // session preserved
  });

  it("orderPartRequestAction — advisor orders → job pauses AND session closes", async () => {
    const { job, session } = await seedJobInRepair();
    // Seed a request in REQUESTED so the advisor can ORDER it.
    const req = await prisma.partRequest.create({
      data: {
        garageId: gid,
        jobCardId: job.id,
        description: "Belt",
        qty: 1,
        status: "REQUESTED",
        requestedById: techId,
      },
    });
    mockAuth.mockResolvedValue({ user: { id: advisorId, garageId: gid, role: "ADVISOR", email: "x", name: "x" } });

    await orderPartRequestAction(form({ requestId: req.id }));

    const j = await prisma.jobCard.findUnique({ where: { id: job.id } });
    expect(j!.status).toBe("ON_HOLD");
    expect(j!.holdReason).toBe("AWAITING_PART");
    const s = await prisma.workSession.findUnique({ where: { id: session.id } });
    expect(s!.endedAt).not.toBeNull();
    expect(s!.endReason).toBe("JOB_CLOSED");
  });
});

describe("close-on-hold — claim lifecycle (AR 2026-08-20 follow-up)", () => {
  // The AA0076 leak vector: releaseJobAction / reassignJobAction
  // nulled claimedById + claimedAt but never called closeJobSessions.
  // The session survived the release → next re-claim hit the
  // "already on this car" no-op in startWorkSession → row's
  // startedAt preserved from the ORIGINAL claim. Floor showed 29.8h
  // for a job the tech had physically stopped ~26h before.
  //
  // Pin both close sites. Also assert the semantic AR asked to
  // confirm: after release closes the session, a re-claim opens a
  // FRESH row rather than reusing the old one.

  it("releaseJobAction — the tech's open session closes with JOB_CLOSED", async () => {
    const { job, session } = await seedJobInRepair();
    mockAuth.mockResolvedValue({ user: { id: techId, garageId: gid, role: "TECH", email: "x", name: "x" } });

    await releaseJobAction(form({ jobId: job.id }));

    const j = await prisma.jobCard.findUnique({ where: { id: job.id } });
    expect(j!.claimedById).toBeNull();
    expect(j!.claimedAt).toBeNull();
    const s = await prisma.workSession.findUnique({ where: { id: session.id } });
    expect(s!.endedAt).not.toBeNull();
    expect(s!.endReason).toBe("JOB_CLOSED");
  });

  it("re-claim after release opens a FRESH session (no 'already on this car' no-op)", async () => {
    // AR's semantic question: one release + one re-claim = two
    // sessions, with the gap uncovered. Pinned here — a re-claim
    // via claimJobAction / startWorkAction that follows a release
    // MUST create a new WorkSession row, not resurrect the closed
    // one or preserve its startedAt.
    const { job, session: first } = await seedJobInRepair();
    mockAuth.mockResolvedValue({ user: { id: techId, garageId: gid, role: "TECH", email: "x", name: "x" } });

    // Capture the release wallclock so we can assert the re-claim's
    // startedAt is post-release rather than the leaked original.
    // Small sleep so the second session's startedAt is measurably
    // after the release timestamp under coarse system clocks.
    const beforeRelease = new Date();
    await releaseJobAction(form({ jobId: job.id }));
    const s1 = await prisma.workSession.findUnique({ where: { id: first.id } });
    expect(s1!.endedAt).not.toBeNull();
    expect(s1!.endedAt!.getTime()).toBeGreaterThanOrEqual(beforeRelease.getTime());

    // Simulate the re-claim's effect directly: startWorkSession is
    // what claimJobAction calls after writing claimedById. Test the
    // module boundary rather than the full claim flow because
    // claimJobAction has its own conditional-update semantics that
    // aren't the point of THIS test.
    const { startWorkSession } = await import("@/lib/work-session");
    await startWorkSession(gid, job.id, techId);

    const openNow = await prisma.workSession.findMany({
      where: { jobCardId: job.id, endedAt: null },
    });
    expect(openNow).toHaveLength(1);
    // Linchpin: the open session is NOT the one we closed above.
    expect(openNow[0].id).not.toBe(first.id);
    // And it's a new row created after we started this test, not
    // a resurrection of the closed one.
    expect(openNow[0].startedAt.getTime()).toBeGreaterThanOrEqual(beforeRelease.getTime());
  });

  it("reassignJobAction — advisor reassigns → open session closes with JOB_CLOSED", async () => {
    const { job, session } = await seedJobInRepair();
    mockAuth.mockResolvedValue({ user: { id: advisorId, garageId: gid, role: "ADVISOR", email: "x", name: "x" } });

    // Reassign to the shared pool (blank assignedToId — same shape
    // as the /advisor UI's "un-assign" button).
    await reassignJobAction(form({ jobId: job.id, assignedToId: "" }));

    const j = await prisma.jobCard.findUnique({ where: { id: job.id } });
    expect(j!.claimedById).toBeNull();
    expect(j!.claimedAt).toBeNull();
    const s = await prisma.workSession.findUnique({ where: { id: session.id } });
    expect(s!.endedAt).not.toBeNull();
    expect(s!.endReason).toBe("JOB_CLOSED");
  });
});
