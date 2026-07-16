/**
 * Ledger feed parity — the SQL UNION used by the paginated ledger MUST
 * produce the exact same ordering as the JS merge that page.tsx runs
 * today. If they drift, the owner reads a wrong page slice with no error
 * — money misreported silently.
 *
 * This test seeds interleaved Payment + AdvancePayment rows (including
 * ties on the timestamp) into a scratch garage, then compares:
 *   (a) the id list produced by mergeLedgerFeed(payments, advances)
 *       when the raw rows come from prisma.findMany, same shape as
 *       page.tsx uses
 *   (b) the id list produced by the paginated UNION raw SQL over the
 *       same window
 * and asserts (a) === (b) position by position.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { mergeLedgerFeed } from "@/lib/ledger-feed";
import { runLedgerFeedUnion } from "@/lib/ledger-feed-query";

const P = "ledger-parity-";
const gId = P + "garage";
const custId = P + "cust";
const vehId = P + "veh";
const jobId = P + "job";
const invIdBase = P + "inv-";

async function cleanup() {
  await prisma.payment.deleteMany({ where: { invoice: { garageId: gId } } });
  await prisma.advancePayment.deleteMany({ where: { garageId: gId } });
  await prisma.invoiceLine.deleteMany({ where: { invoice: { garageId: gId } } });
  await prisma.invoice.deleteMany({ where: { garageId: gId } });
  await prisma.jobCard.deleteMany({ where: { garageId: gId } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: gId } } });
  await prisma.customer.deleteMany({ where: { garageId: gId } });
  await prisma.garage.deleteMany({ where: { id: gId } });
}

/** Seed a garage with N pairs of Payment + AdvancePayment whose
 *  timestamps INTERLEAVE (P/A/P/A ...) plus 3 pairs with IDENTICAL
 *  timestamps (the tie edge case where drift lives). */
async function seed(): Promise<{ ids: string[]; from: Date; to: Date }> {
  await prisma.garage.create({ data: { id: gId, name: gId } });
  await prisma.customer.create({
    data: { id: custId, garageId: gId, name: "Owner Parity", phone: P + "888" },
  });
  await prisma.vehicle.create({
    data: { id: vehId, customerId: custId, plate: P + "PLT", make: "Toyota", model: "Hilux" },
  });
  await prisma.jobCard.create({
    data: { id: jobId, garageId: gId, vehicleId: vehId, status: "DELIVERED" },
  });

  const baseline = new Date("2026-07-01T00:00:00Z").getTime();
  const step = 60_000; // 1 minute between rows
  const from = new Date(baseline - step);
  const to = new Date(baseline + step * 1000);

  const ids: string[] = [];

  // Interleaved: t0=P, t0+1=A, t0+2=P, t0+3=A ... 20 rows total (10P + 10A)
  for (let i = 0; i < 20; i++) {
    const at = new Date(baseline + i * step);
    if (i % 2 === 0) {
      const invId = invIdBase + i;
      const pId = P + "pay-" + i;
      await prisma.invoice.create({
        data: {
          id: invId,
          garageId: gId,
          jobCardId: jobId,
          number: 10_000 + i,
          issuedAt: at,
          dueDate: at,
          subtotal: 100,
          vatAmount: 5,
          total: 105,
          status: "PAID",
        },
      });
      await prisma.payment.create({
        data: { id: pId, invoiceId: invId, amount: 105, method: "CASH", paidAt: at },
      });
      ids.push(pId);
    } else {
      const aId = P + "adv-" + i;
      await prisma.advancePayment.create({
        data: {
          id: aId,
          garageId: gId,
          jobCardId: jobId,
          amount: 50,
          method: "CARD_POS",
          receivedAt: at,
        },
      });
      ids.push(aId);
    }
  }

  // Ties: 3 pairs sharing the exact same timestamp — one Payment + one
  // Advance at the same instant. The JS merge sorts stably, so PAYMENT
  // beats ADVANCE on tie because ...payments comes first in the array.
  // The UNION SQL must match via kind_ord.
  for (let i = 0; i < 3; i++) {
    const at = new Date(baseline + (20 + i) * step);
    const invId = invIdBase + "tie-" + i;
    const pId = P + "pay-tie-" + i;
    const aId = P + "adv-tie-" + i;
    await prisma.invoice.create({
      data: {
        id: invId,
        garageId: gId,
        jobCardId: jobId,
        number: 20_000 + i,
        issuedAt: at,
        dueDate: at,
        subtotal: 200,
        vatAmount: 10,
        total: 210,
        status: "PAID",
      },
    });
    await prisma.payment.create({
      data: { id: pId, invoiceId: invId, amount: 210, method: "CASH", paidAt: at },
    });
    await prisma.advancePayment.create({
      data: {
        id: aId,
        garageId: gId,
        jobCardId: jobId,
        amount: 60,
        method: "CARD_POS",
        receivedAt: at,
      },
    });
    ids.push(pId, aId);
  }

  return { ids, from, to: new Date(baseline + (100) * step) };
}

beforeEach(async () => {
  await cleanup();
});
afterAll(cleanup);

describe("ledger feed — JS merge vs SQL UNION parity", () => {
  it("full-window: UNION id list matches JS merge id list", async () => {
    const { from, to } = await seed();

    // (a) the JS side — same query shape as page.tsx uses
    const payments = await prisma.payment.findMany({
      where: {
        invoice: { garageId: { in: [gId] } },
        paidAt: { gte: from, lte: to },
      },
      orderBy: { paidAt: "desc" },
      select: {
        id: true,
        amount: true,
        method: true,
        paidAt: true,
        invoice: {
          select: {
            number: true,
            jobCard: {
              select: { vehicle: { select: { customer: { select: { name: true } } } } },
            },
          },
        },
      },
    });
    const advances = await prisma.advancePayment.findMany({
      where: { garageId: { in: [gId] }, receivedAt: { gte: from, lte: to } },
      orderBy: { receivedAt: "desc" },
      select: {
        id: true,
        amount: true,
        method: true,
        receivedAt: true,
        migratedAt: true,
        jobCard: {
          select: { vehicle: { select: { customer: { select: { name: true } } } } },
        },
      },
    });
    const jsIds = mergeLedgerFeed(payments, advances).map((r) => r.id);

    // (b) the SQL UNION side — full window, no offset
    const { rows: unionRows, totalCount } = await runLedgerFeedUnion({
      garageIds: [gId],
      from,
      to,
      skip: 0,
      take: 1000,
    });
    const unionIds = unionRows.map((r) => r.id);

    expect(totalCount).toBe(jsIds.length);
    expect(unionIds).toEqual(jsIds);
  });

  it("paginated slice: UNION page-2 slice equals JS merge page-2 slice", async () => {
    const { from, to } = await seed();

    const payments = await prisma.payment.findMany({
      where: {
        invoice: { garageId: { in: [gId] } },
        paidAt: { gte: from, lte: to },
      },
      orderBy: { paidAt: "desc" },
      select: {
        id: true,
        amount: true,
        method: true,
        paidAt: true,
        invoice: {
          select: {
            number: true,
            jobCard: {
              select: { vehicle: { select: { customer: { select: { name: true } } } } },
            },
          },
        },
      },
    });
    const advances = await prisma.advancePayment.findMany({
      where: { garageId: { in: [gId] }, receivedAt: { gte: from, lte: to } },
      orderBy: { receivedAt: "desc" },
      select: {
        id: true,
        amount: true,
        method: true,
        receivedAt: true,
        migratedAt: true,
        jobCard: {
          select: { vehicle: { select: { customer: { select: { name: true } } } } },
        },
      },
    });
    const jsSlice = mergeLedgerFeed(payments, advances)
      .slice(10, 20)
      .map((r) => r.id);

    const { rows: unionRows } = await runLedgerFeedUnion({
      garageIds: [gId],
      from,
      to,
      skip: 10,
      take: 10,
    });
    const unionSlice = unionRows.map((r) => r.id);

    expect(unionSlice).toEqual(jsSlice);
  });

  it("ties: PAYMENT beats ADVANCE at identical timestamps in both paths", async () => {
    const { from, to } = await seed();
    // Rows 20+ share timestamps in pairs (Payment first in seed). Find them.
    const tiePayIds = ["pay-tie-0", "pay-tie-1", "pay-tie-2"].map((s) => P + s);
    const tieAdvIds = ["adv-tie-0", "adv-tie-1", "adv-tie-2"].map((s) => P + s);

    const { rows } = await runLedgerFeedUnion({
      garageIds: [gId],
      from,
      to,
      skip: 0,
      take: 1000,
    });
    const positionOf = (id: string) => rows.findIndex((r) => r.id === id);

    // For each tie pair, the Payment must appear BEFORE the Advance in
    // the UNION output — mirrors the JS merge's stable-sort behaviour.
    for (let i = 0; i < 3; i++) {
      expect(positionOf(tiePayIds[i])).toBeLessThan(positionOf(tieAdvIds[i]));
    }
  });
});
