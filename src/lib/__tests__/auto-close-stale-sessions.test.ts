/**
 * autoCloseStaleSessions — nightly cron helper (AR 2026-08-20
 * Finding 2, third pillar). Sessions still open longer than the
 * threshold get closed with endReason='AUTO_CLOSED' and
 * laborCostSnapshot=NULL — we don't know when the tech actually
 * stopped, so a duration-derived cost figure would be fabricated.
 * Same "flag rather than cap or rewrite" principle as the historical
 * flag + the ledger replay decisions.
 *
 * Covers:
 *   A) Session older than threshold → closed, endReason=AUTO_CLOSED,
 *      laborCostSnapshot=null, endedAt=now (no matter what the shop
 *      rate is — cost derivation deliberately skipped).
 *   B) Session younger than threshold → left open.
 *   C) Already-closed session → untouched.
 *   D) Return payload carries per-session detail (tech, job, duration)
 *      for the cron's log-and-report contract.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { autoCloseStaleSessions } from "@/lib/work-session";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";

const P = "auto-close-stale-test-";
const gid = P + "g1";
const techId = P + "tech";

const HOUR = 60 * 60 * 1000;
const TWELVE_H = 12 * HOUR;

async function cleanup() {
  await prisma.workSession.deleteMany({ where: { garageId: gid } });
  await withDeleteGuardBypass(prisma, async (tx) => {
    await tx.payment.deleteMany({ where: { invoice: { garageId: gid } } });
    await tx.invoice.deleteMany({ where: { garageId: gid } });
  });
  await prisma.jobCard.deleteMany({ where: { garageId: gid } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: gid } } });
  await prisma.customer.deleteMany({ where: { garageId: gid } });
  await prisma.user.deleteMany({ where: { garageId: gid } });
  await prisma.garage.deleteMany({ where: { id: gid } });
}

async function seedJobAndTech() {
  const customer = await prisma.customer.upsert({
    where: { id: P + "c" }, update: {},
    create: { id: P + "c", garageId: gid, name: "C", phone: P + "ph" },
  });
  const vehicle = await prisma.vehicle.upsert({
    where: { id: P + "v" }, update: {},
    create: { id: P + "v", customerId: customer.id, make: "T", model: "C", plate: P + "plt" },
  });
  const job = await prisma.jobCard.create({
    data: { garageId: gid, vehicleId: vehicle.id, status: "REPAIR", number: Math.floor(Math.random() * 900000) + 100000 },
  });
  return job;
}

async function openSession(jobId: string, startedAt: Date) {
  return prisma.workSession.create({
    data: { garageId: gid, jobCardId: jobId, techId, startedAt },
  });
}

beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: gid, name: gid } });
  await prisma.user.create({
    data: { id: techId, garageId: gid, role: "TECH", name: "Tariq", email: techId + "@t.test" },
  });
});
afterAll(cleanup);

describe("autoCloseStaleSessions", () => {
  it("A) session > 12h → closed with AUTO_CLOSED, null cost snapshot", async () => {
    const job = await seedJobAndTech();
    // 16h old — well past the threshold, mirrors the INV-2026-0051 pattern
    const started = new Date(Date.now() - 16 * HOUR);
    // Set a shop rate so we can prove the cron ignores it (autoclose
    // MUST leave laborCostSnapshot null regardless).
    await prisma.garage.update({
      where: { id: gid }, data: { defaultLaborHourlyCost: "60" },
    });
    const s = await openSession(job.id, started);

    const closed = await autoCloseStaleSessions(TWELVE_H);
    expect(closed).toHaveLength(1);
    expect(closed[0].id).toBe(s.id);
    // Duration hours reported at 1-dp precision — used by the cron log.
    expect(closed[0].durationHours).toBeGreaterThanOrEqual(15.9);
    expect(closed[0].durationHours).toBeLessThanOrEqual(16.1);

    const row = await prisma.workSession.findUnique({ where: { id: s.id } });
    expect(row!.endedAt).not.toBeNull();
    expect(row!.endReason).toBe("AUTO_CLOSED");
    // Linchpin — the shop has a rate, but the cron leaves cost null.
    // We don't know when the tech actually stopped; a rate-derived
    // cost would be fabricated.
    expect(row!.laborCostSnapshot).toBeNull();
  });

  it("B) session under 12h → left open (edge case: just under)", async () => {
    const job = await seedJobAndTech();
    const started = new Date(Date.now() - (TWELVE_H - HOUR));
    const s = await openSession(job.id, started);

    const closed = await autoCloseStaleSessions(TWELVE_H);
    expect(closed).toHaveLength(0);
    const row = await prisma.workSession.findUnique({ where: { id: s.id } });
    expect(row!.endedAt).toBeNull();
    expect(row!.endReason).toBeNull();
  });

  it("C) already-closed session → not re-touched", async () => {
    const job = await seedJobAndTech();
    const started = new Date(Date.now() - 20 * HOUR);
    const preClosed = new Date(Date.now() - HOUR);
    const s = await prisma.workSession.create({
      data: {
        garageId: gid, jobCardId: job.id, techId,
        startedAt: started, endedAt: preClosed, endReason: "COMPLETED",
        laborCostSnapshot: "120.00",
      },
    });

    const closed = await autoCloseStaleSessions(TWELVE_H);
    expect(closed).toHaveLength(0);
    const row = await prisma.workSession.findUnique({ where: { id: s.id } });
    expect(row!.endReason).toBe("COMPLETED"); // untouched
    expect(row!.endedAt!.getTime()).toBe(preClosed.getTime());
    expect(row!.laborCostSnapshot!.toString()).toBe("120");
  });

  it("D) return payload includes tech name + job number + duration for the cron log", async () => {
    const job = await seedJobAndTech();
    const started = new Date(Date.now() - 14 * HOUR);
    await openSession(job.id, started);

    const closed = await autoCloseStaleSessions(TWELVE_H);
    expect(closed).toHaveLength(1);
    expect(closed[0].techName).toBe("Tariq");
    expect(closed[0].jobCardNumber).toBe(job.number);
    expect(closed[0].startedAt.getTime()).toBe(started.getTime());
  });
});
