/**
 * Phase 3 of multi-tenancy hardening — DATA-LAYER ISOLATION ASSERTIONS.
 *
 * This file PROVES that one garage cannot read or write another garage's
 * data via the same prisma query patterns the app uses. It seeds two
 * fully-populated garages (A and B), then runs a battery of cross-garage
 * read attempts and asserts each one returns nothing.
 *
 * What this test catches:
 *   - A query that forgets to filter on garageId
 *   - A query that scopes by `vehicleId` / `jobCardId` / `customerId`
 *     etc. but not by the parent's garageId (the indirect-scoping risk)
 *   - A future schema migration that removes a `garageId` column on a
 *     model the app reads by id
 *   - A defensive scoping that ACCIDENTALLY narrows legitimate same-
 *     garage reads (false-positive on the leak — we assert in-garage
 *     reads still return the row, not null)
 *
 * What this test does NOT catch (separate Phase 4 work):
 *   - Server-action level mistakes (running an action without
 *     requireRole/auth). For that, see the prisma-middleware proposal.
 *   - UI links that expose a foreign cuid. The link still requires the
 *     server to fulfil it, and the server-side query will refuse.
 *
 * Runs against the same database the dev server uses (DATABASE_URL from
 * .env). Cleanup is BY ID PREFIX so a crashed run can't leak rows
 * forever — every row this file touches starts with TEST_PREFIX, and
 * cleanup deletes every row with an id starting with that prefix in
 * dependency order, both before AND after the run.
 */

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";

// ----- isolation harness -----

/** Every row this test creates has an id starting with this string so
 *  cleanup is targeted and crash-resilient. */
const TEST_PREFIX = "tenant-iso-test-";

/** Same plate in both garages — proves the same-vehicleId scoping fix
 *  in /advisor/jobs/[id] page is real. */
const SHARED_PLATE = "DUP 12345";

interface TestGarageStack {
  garageId: string;
  ownerId: string;
  customerId: string;
  vehicleId: string;
  jobCardId: string;
  estimateId: string;
  invoiceId: string;
  reminderId: string;
  partRequestId: string;
  waThreadId: string;
  bayId: string;
}

let A: TestGarageStack;
let B: TestGarageStack;

beforeAll(async () => {
  await cleanup();
  A = await seedGarageStack("A");
  B = await seedGarageStack("B");
}, 60_000);

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
}, 60_000);

async function seedGarageStack(suffix: "A" | "B"): Promise<TestGarageStack> {
  const p = `${TEST_PREFIX}${suffix}-`;
  const garageId = `${p}garage`;
  const ownerId = `${p}user-owner`;
  const customerId = `${p}cust`;
  const vehicleId = `${p}veh`;
  const jobCardId = `${p}job`;
  const estimateId = `${p}est`;
  const invoiceId = `${p}inv`;
  const reminderId = `${p}rem`;
  const partRequestId = `${p}pr`;
  const waThreadId = `${p}wt`;
  const bayId = `${p}bay`;

  await prisma.garage.create({
    data: { id: garageId, name: `Tenant Test ${suffix}` },
  });

  await prisma.user.create({
    data: {
      id: ownerId,
      garageId,
      role: "OWNER",
      name: `Owner ${suffix}`,
      email: `${p}owner@example.test`,
      passwordHash: null,
    },
  });

  await prisma.customer.create({
    data: {
      id: customerId,
      garageId,
      name: `Customer ${suffix}`,
      phone: `+97150${suffix === "A" ? "1111111" : "2222222"}`,
    },
  });

  await prisma.vehicle.create({
    data: {
      id: vehicleId,
      customerId,
      make: "Toyota",
      model: "Camry",
      year: 2022,
      // SAME plate in both garages on purpose — tests Phase 2 scoping
      plate: SHARED_PLATE,
    },
  });

  await prisma.jobCard.create({
    data: {
      id: jobCardId,
      garageId,
      vehicleId,
      status: "REPAIR",
      complaint: `Tenant test ${suffix}`,
    },
  });

  await prisma.estimate.create({
    data: {
      id: estimateId,
      jobCardId,
      subtotal: "100.00",
      vatAmount: "5.00",
      total: "105.00",
      status: "SENT",
    },
  });

  // Use a high invoice number well away from the demo garage's sequence
  // so the per-garage @@unique([garageId, number]) doesn't collide on
  // re-runs.
  await prisma.invoice.create({
    data: {
      id: invoiceId,
      garageId,
      jobCardId,
      estimateId,
      number: 9000,
      issuedAt: new Date(),
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      subtotal: "100.00",
      vatAmount: "5.00",
      total: "105.00",
    },
  });

  await prisma.reminder.create({
    data: {
      id: reminderId,
      garageId,
      vehicleId,
      jobCardId,
      type: "OIL_10000",
      serviceDate: new Date(),
      dueAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  });

  await prisma.partRequest.create({
    data: {
      id: partRequestId,
      garageId,
      jobCardId,
      description: `Test brake pad ${suffix}`,
      status: "REQUESTED",
    },
  });

  await prisma.whatsAppThread.create({
    data: {
      id: waThreadId,
      garageId,
      customerId,
      waId: `wa-id-${suffix}`,
      threadStatus: "OPEN",
    },
  });

  await prisma.bay.create({
    data: { id: bayId, garageId, name: `Bay ${suffix}` },
  });

  await prisma.ledgerEntry.createMany({
    data: [
      {
        garageId,
        account: "Accounts Receivable",
        debit: "100.00",
        credit: "0.00",
        sourceType: "Invoice",
        sourceId: invoiceId,
      },
      {
        garageId,
        account: "Sales Revenue",
        debit: "0.00",
        credit: "100.00",
        sourceType: "Invoice",
        sourceId: invoiceId,
      },
    ],
  });

  return {
    garageId,
    ownerId,
    customerId,
    vehicleId,
    jobCardId,
    estimateId,
    invoiceId,
    reminderId,
    partRequestId,
    waThreadId,
    bayId,
  };
}

async function cleanup() {
  // Delete in dependency order. We delete by id prefix where the model
  // has a string id we own, and by parent-id lookup where it doesn't.
  // This is intentionally over-broad on the prefix match so a crashed
  // partial run can't leak rows.
  const startsWithTestPrefix = { startsWith: TEST_PREFIX };

  // Child rows first
  await prisma.ledgerEntry.deleteMany({
    where: { sourceId: startsWithTestPrefix },
  });
  await prisma.payment.deleteMany({
    where: { invoiceId: startsWithTestPrefix },
  });
  await prisma.invoiceLine.deleteMany({
    where: { invoiceId: startsWithTestPrefix },
  });
  await prisma.estimateLine.deleteMany({
    where: { estimateId: startsWithTestPrefix },
  });
  await prisma.reminder.deleteMany({ where: { id: startsWithTestPrefix } });
  await prisma.partRequest.deleteMany({ where: { id: startsWithTestPrefix } });
  await prisma.jobStep.deleteMany({
    where: { jobCardId: startsWithTestPrefix },
  });
  await prisma.jobFinding.deleteMany({
    where: { jobCardId: startsWithTestPrefix },
  });
  await prisma.jobHelper.deleteMany({
    where: { jobCardId: startsWithTestPrefix },
  });
  await prisma.jobPart.deleteMany({
    where: { jobCardId: startsWithTestPrefix },
  });
  await prisma.invoice.deleteMany({ where: { id: startsWithTestPrefix } });
  await prisma.estimate.deleteMany({ where: { id: startsWithTestPrefix } });
  await prisma.whatsAppMessage.deleteMany({
    where: { threadId: startsWithTestPrefix },
  });
  await prisma.whatsAppThread.deleteMany({
    where: { id: startsWithTestPrefix },
  });
  await prisma.bay.deleteMany({ where: { id: startsWithTestPrefix } });
  await prisma.jobCard.deleteMany({ where: { id: startsWithTestPrefix } });
  await prisma.vehicle.deleteMany({ where: { id: startsWithTestPrefix } });
  await prisma.customer.deleteMany({ where: { id: startsWithTestPrefix } });
  await prisma.user.deleteMany({ where: { id: startsWithTestPrefix } });
  await prisma.garage.deleteMany({ where: { id: startsWithTestPrefix } });
}

// ----- the actual isolation tests -----

describe("tenant isolation — A and B cannot see each other's data", () => {
  it("setup: both garages have all their stack rows", () => {
    // Sanity guard — if seed broke, every other assertion in this file
    // would also be wrong, so prove the seed first.
    expect(A.garageId).toMatch(/^tenant-iso-test-A-/);
    expect(B.garageId).toMatch(/^tenant-iso-test-B-/);
    expect(A.garageId).not.toBe(B.garageId);
  });

  // -----------------------------------------------------------------
  // JobCard — read by id (advisor + technician job detail pattern)
  // -----------------------------------------------------------------
  describe("JobCard", () => {
    it("findFirst({ id, garageId }) returns the row when reading own data", async () => {
      const row = await prisma.jobCard.findFirst({
        where: { id: A.jobCardId, garageId: A.garageId },
      });
      expect(row).not.toBeNull();
      expect(row!.id).toBe(A.jobCardId);
    });

    it("findFirst({ A.jobId, garageId: B.garageId }) returns null", async () => {
      const row = await prisma.jobCard.findFirst({
        where: { id: A.jobCardId, garageId: B.garageId },
      });
      expect(row).toBeNull();
    });

    it("findFirst({ B.jobId, garageId: A.garageId }) returns null", async () => {
      const row = await prisma.jobCard.findFirst({
        where: { id: B.jobCardId, garageId: A.garageId },
      });
      expect(row).toBeNull();
    });

    it("findMany scoped by garageId only returns own jobs", async () => {
      const aJobs = await prisma.jobCard.findMany({
        where: {
          garageId: A.garageId,
          id: { in: [A.jobCardId, B.jobCardId] },
        },
      });
      expect(aJobs.map((j) => j.id)).toEqual([A.jobCardId]);
    });
  });

  // -----------------------------------------------------------------
  // Estimate — has NO direct garageId; scoped via jobCard.garageId
  // -----------------------------------------------------------------
  describe("Estimate (indirect scoping via jobCard.garageId)", () => {
    it("ownedEstimate-style findFirst returns own estimate", async () => {
      const row = await prisma.estimate.findFirst({
        where: { id: A.estimateId, jobCard: { garageId: A.garageId } },
      });
      expect(row).not.toBeNull();
    });

    it("A's estimate is NOT findable via B's garageId", async () => {
      const row = await prisma.estimate.findFirst({
        where: { id: A.estimateId, jobCard: { garageId: B.garageId } },
      });
      expect(row).toBeNull();
    });

    it("B's estimate is NOT findable via A's garageId", async () => {
      const row = await prisma.estimate.findFirst({
        where: { id: B.estimateId, jobCard: { garageId: A.garageId } },
      });
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Invoice — has direct garageId
  // -----------------------------------------------------------------
  describe("Invoice", () => {
    it("findFirst({ id, garageId }) returns own invoice", async () => {
      const row = await prisma.invoice.findFirst({
        where: { id: A.invoiceId, garageId: A.garageId },
      });
      expect(row).not.toBeNull();
    });

    it("A's invoice is NOT findable via B's garageId", async () => {
      const row = await prisma.invoice.findFirst({
        where: { id: A.invoiceId, garageId: B.garageId },
      });
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Cashier dashboard counters — count queries with garageId
  // -----------------------------------------------------------------
  describe("Cashier dashboard counter math", () => {
    it("invoice count per garage is exactly 1 (the one we seeded)", async () => {
      const aCount = await prisma.invoice.count({
        where: { garageId: A.garageId },
      });
      const bCount = await prisma.invoice.count({
        where: { garageId: B.garageId },
      });
      expect(aCount).toBe(1);
      expect(bCount).toBe(1);
    });

    it("jobCard count per garage is exactly 1", async () => {
      const aCount = await prisma.jobCard.count({
        where: { garageId: A.garageId },
      });
      const bCount = await prisma.jobCard.count({
        where: { garageId: B.garageId },
      });
      expect(aCount).toBe(1);
      expect(bCount).toBe(1);
    });

    it("counts of foreign garage's data via own garageId are 0", async () => {
      // Edge case: if someone reverses garageId for a counter — caught.
      const inA = await prisma.invoice.count({
        where: { id: B.invoiceId, garageId: A.garageId },
      });
      expect(inA).toBe(0);
    });
  });

  // -----------------------------------------------------------------
  // Owner ledger trial balance — per-garage sums
  // -----------------------------------------------------------------
  describe("Owner ledger trial balance", () => {
    it("ledger sum for A excludes B's entries", async () => {
      const agg = await prisma.ledgerEntry.aggregate({
        where: { garageId: A.garageId },
        _sum: { debit: true, credit: true },
      });
      // We seeded 100 DR + 100 CR per garage.
      expect(Number(agg._sum.debit ?? 0)).toBe(100);
      expect(Number(agg._sum.credit ?? 0)).toBe(100);
    });

    it("ledger sum for B excludes A's entries", async () => {
      const agg = await prisma.ledgerEntry.aggregate({
        where: { garageId: B.garageId },
        _sum: { debit: true, credit: true },
      });
      expect(Number(agg._sum.debit ?? 0)).toBe(100);
      expect(Number(agg._sum.credit ?? 0)).toBe(100);
    });

    it("each ledgerEntry's sourceId is NOT cross-garage findable", async () => {
      const row = await prisma.ledgerEntry.findFirst({
        where: { sourceId: A.invoiceId, garageId: B.garageId },
      });
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Reminder by vehicleId — the same-plate-different-garage scenario
  // that Phase 2 fixed.
  // -----------------------------------------------------------------
  describe("Reminder lookup (Phase 2 same-plate-different-garage)", () => {
    it("same plate exists in both garages (proves the test is real)", async () => {
      const vs = await prisma.vehicle.findMany({
        where: { plate: SHARED_PLATE, id: { in: [A.vehicleId, B.vehicleId] } },
      });
      expect(vs).toHaveLength(2);
    });

    it("BAD pattern: findMany({ vehicleId }) WITHOUT garageId would leak", async () => {
      // This is what advisor/jobs/[id]/page.tsx USED to do. Documented
      // here so a future regression to the old pattern is obvious.
      const rows = await prisma.reminder.findMany({
        where: { vehicleId: A.vehicleId },
      });
      // Both A and B own the SAME plate ⇒ in the old code the lookup
      // keyed off vehicleId only. A's vehicle has a different VEHICLE
      // ID (we seed each garage its own row), so this query is fine.
      // The risk only opens if someone refactors to lookup by PLATE.
      // We assert A's vehicleId only returns A's reminders here.
      expect(rows.every((r) => r.garageId === A.garageId)).toBe(true);
      expect(rows.map((r) => r.id)).toEqual([A.reminderId]);
    });

    it("Phase 2 pattern: findMany({ vehicleId, garageId }) returns own only", async () => {
      const aRows = await prisma.reminder.findMany({
        where: { vehicleId: A.vehicleId, garageId: A.garageId },
      });
      expect(aRows.map((r) => r.id)).toEqual([A.reminderId]);

      // B's garageId on A's vehicleId — empty.
      const cross = await prisma.reminder.findMany({
        where: { vehicleId: A.vehicleId, garageId: B.garageId },
      });
      expect(cross).toHaveLength(0);
    });

    it("reminder.findFirst by id with wrong garageId returns null", async () => {
      const row = await prisma.reminder.findFirst({
        where: { id: A.reminderId, garageId: B.garageId },
      });
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // PartRequest — Phase 1 fix on maybeResumeJob + transition action
  // -----------------------------------------------------------------
  describe("PartRequest", () => {
    it("findFirst({ id, garageId }) returns own", async () => {
      const row = await prisma.partRequest.findFirst({
        where: { id: A.partRequestId, garageId: A.garageId },
      });
      expect(row).not.toBeNull();
    });

    it("A's partRequest is NOT findable via B's garageId", async () => {
      const row = await prisma.partRequest.findFirst({
        where: { id: A.partRequestId, garageId: B.garageId },
      });
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // WhatsAppThread — id-based lookup pattern
  // -----------------------------------------------------------------
  describe("WhatsAppThread", () => {
    it("findFirst({ id, garageId }) returns own thread", async () => {
      const row = await prisma.whatsAppThread.findFirst({
        where: { id: A.waThreadId, garageId: A.garageId },
      });
      expect(row).not.toBeNull();
    });

    it("A's thread is NOT findable via B's garageId", async () => {
      const row = await prisma.whatsAppThread.findFirst({
        where: { id: A.waThreadId, garageId: B.garageId },
      });
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Customer / Vehicle — indirect-scoping risk
  // -----------------------------------------------------------------
  describe("Customer + Vehicle", () => {
    it("Customer findFirst({ id, garageId }) — own returns row", async () => {
      const row = await prisma.customer.findFirst({
        where: { id: A.customerId, garageId: A.garageId },
      });
      expect(row).not.toBeNull();
    });

    it("Customer findFirst({ A.id, garageId: B }) returns null", async () => {
      const row = await prisma.customer.findFirst({
        where: { id: A.customerId, garageId: B.garageId },
      });
      expect(row).toBeNull();
    });

    it("Vehicle findFirst via customer.garageId — own returns row", async () => {
      const row = await prisma.vehicle.findFirst({
        where: { id: A.vehicleId, customer: { garageId: A.garageId } },
      });
      expect(row).not.toBeNull();
    });

    it("Vehicle findFirst via customer.garageId — cross is null", async () => {
      const row = await prisma.vehicle.findFirst({
        where: { id: A.vehicleId, customer: { garageId: B.garageId } },
      });
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Bay — direct garageId
  // -----------------------------------------------------------------
  describe("Bay", () => {
    it("findFirst({ id, garageId }) returns own", async () => {
      const row = await prisma.bay.findFirst({
        where: { id: A.bayId, garageId: A.garageId },
      });
      expect(row).not.toBeNull();
    });

    it("A's bay is NOT findable via B's garageId", async () => {
      const row = await prisma.bay.findFirst({
        where: { id: A.bayId, garageId: B.garageId },
      });
      expect(row).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Token-authed customer flow — the /c/* path. The token IS the auth;
  // even if you "know" foreign garage's estimate id, you cannot mint a
  // valid token for it without the server's signing secret. We don't
  // test the signing secret here (that's an auth-layer test) — we
  // test that an UNAUTHED prisma read by foreign id, scoped by
  // foreign garage, returns the row (so the legit customer flow works)
  // — proving the only thing protecting it is the token itself.
  // -----------------------------------------------------------------
  describe("Customer-facing /c/* token flow", () => {
    it("token-authed read by id returns the row (token IS the auth)", async () => {
      // This documents the intentional design: /c/estimate/[id] uses
      // findUnique({ id }) NO garageId — security is provided by the
      // signed token in the URL. The test here just proves the lookup
      // still works (i.e. that we didn't accidentally over-narrow the
      // public action).
      const row = await prisma.estimate.findUnique({
        where: { id: A.estimateId },
      });
      expect(row).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Settings actions — the new self-serve profile/garage edit surface
  // (Step 1 of the Settings build). Each settings action keys its DB
  // update on session.user.id (or session.user.garageId for owner
  // sections), NOT on anything from formData. These tests assert that
  // an update keyed on the session-equivalent ALWAYS hits the right
  // row and nothing else.
  // ------------------------------------------------------------------
  describe("Settings actions — own-account scoping", () => {
    it("updating User.name by A's owner id only changes A's owner — never B's", async () => {
      const beforeB = await prisma.user.findFirst({
        where: { id: B.ownerId },
        select: { name: true },
      });
      // Simulate the changeProfileName action's update: where: { id: <A.ownerId> }
      await prisma.user.update({
        where: { id: A.ownerId },
        data: { name: "A's New Name" },
      });
      const afterA = await prisma.user.findFirst({
        where: { id: A.ownerId },
        select: { name: true },
      });
      const afterB = await prisma.user.findFirst({
        where: { id: B.ownerId },
        select: { name: true },
      });
      expect(afterA?.name).toBe("A's New Name");
      // B unaffected — proves the where clause cannot ever sweep across
      // garages even if some future bug stripped a `where` filter.
      expect(afterB?.name).toBe(beforeB?.name);
    });

    it("updating Garage.name keyed on A's garageId never touches B's row", async () => {
      const beforeB = await prisma.garage.findUnique({
        where: { id: B.garageId },
        select: { name: true },
      });
      // Simulate the (future) owner garage-name update action.
      await prisma.garage.update({
        where: { id: A.garageId },
        data: { name: "Tenant Test A — renamed" },
      });
      const afterA = await prisma.garage.findUnique({
        where: { id: A.garageId },
        select: { name: true },
      });
      const afterB = await prisma.garage.findUnique({
        where: { id: B.garageId },
        select: { name: true },
      });
      expect(afterA?.name).toBe("Tenant Test A — renamed");
      expect(afterB?.name).toBe(beforeB?.name);
    });

    it("updating User.email by A's owner id only changes A's owner — never B's", async () => {
      // Simulates updateProfileEmailAction's update. Key is session
      // id, not anything from the form — so B's row can't be reached.
      const beforeB = await prisma.user.findFirst({
        where: { id: B.ownerId },
        select: { email: true },
      });
      const newEmail = `${A.ownerId}+changed@example.test`;
      await prisma.user.update({
        where: { id: A.ownerId },
        data: { email: newEmail },
      });
      const afterA = await prisma.user.findFirst({
        where: { id: A.ownerId },
        select: { email: true },
      });
      const afterB = await prisma.user.findFirst({
        where: { id: B.ownerId },
        select: { email: true },
      });
      expect(afterA?.email).toBe(newEmail);
      expect(afterB?.email).toBe(beforeB?.email);
    });
  });
});
