/**
 * recordPaymentAction — pin sourceId shape on the paymentLedger
 * write (AR 2026-08-20).
 *
 * Root cause of the 2026-08-20 ledger drift incident: the write at
 * src/app/actions/billing.ts wrote sourceType='PAYMENT' with
 * sourceId=invoice.id instead of payment.id, from the very first
 * commit of billing.ts (98e0402, 2026-05). Every paymentLedger row
 * across prod looked orphan to any join on the Payment table,
 * cleanup-orphan-ledger.mts wiped the whole subledger on 2026-08-20.
 *
 * This test pins the correct shape: for every recordPaymentAction
 * call, the PAYMENT-source ledger rows written must reference the
 * newly-created Payment row's id, not the parent Invoice's id.
 * Regression would silently reintroduce the drift.
 *
 * End-to-end against the local dev DB — auth mocked, session role
 * = CASHIER (INVOICE_ROLES), everything else real.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { mockSessionAndSeed } from "@/lib/__tests__/helpers/mock-session-and-seed";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error("REDIRECT:" + url); },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { recordPaymentAction } = await import("@/app/actions/billing");

const P = "record-payment-ledger-source-test-";
const gid = P + "g1";

async function seedInvoice(total: string) {
  const customer = await prisma.customer.upsert({
    where: { id: P + "c" },
    update: {},
    create: { id: P + "c", garageId: gid, name: "C", phone: P + "phone" },
  });
  const vehicle = await prisma.vehicle.upsert({
    where: { id: P + "v" },
    update: {},
    create: { id: P + "v", customerId: customer.id, make: "T", model: "C", plate: P + "plt" },
  });
  const job = await prisma.jobCard.create({
    data: { garageId: gid, vehicleId: vehicle.id, status: "INVOICED" },
  });
  const number = Math.floor(Math.random() * 1_000_000) + 1;
  const inv = await prisma.invoice.create({
    data: {
      garageId: gid,
      jobCardId: job.id,
      number,
      status: "SENT",
      subtotal: total,
      vatAmount: "0.00",
      total,
      issuedAt: new Date(),
      dueDate: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  return { inv, job };
}

async function cleanup() {
  // Ledger + Payment deletes go through the delete-guard triggers.
  await withDeleteGuardBypass(prisma, async (tx) => {
    await tx.payment.deleteMany({ where: { invoice: { garageId: gid } } });
    await tx.invoice.deleteMany({ where: { garageId: gid } });
  });
  await prisma.ledgerEntry.deleteMany({ where: { garageId: gid } });
  await prisma.jobCard.deleteMany({ where: { garageId: gid } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: gid } } });
  await prisma.customer.deleteMany({ where: { garageId: gid } });
  await prisma.user.deleteMany({ where: { garageId: gid } });
  await prisma.garage.deleteMany({ where: { id: gid } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: gid, name: gid } });
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(
    await mockSessionAndSeed({ id: P + "cashier", garageId: gid, role: "CASHIER" }),
  );
});
afterAll(cleanup);

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("recordPaymentAction — paymentLedger sourceId points at Payment", () => {
  it("writes sourceType='PAYMENT' rows with sourceId = new Payment.id, not Invoice.id", async () => {
    const { inv } = await seedInvoice("100.00");

    await recordPaymentAction(form({
      invoiceId: inv.id,
      amount: "100",
      method: "CASH",
    }));

    // Exactly one Payment row created.
    const payments = await prisma.payment.findMany({ where: { invoiceId: inv.id } });
    expect(payments).toHaveLength(1);
    const paymentId = payments[0].id;

    // Two PAYMENT-source ledger rows written (DR Cash / CR AR). Both
    // must reference the Payment row's id, NOT the parent Invoice's
    // id. The former was the shape the 2026-08-20 fix corrected; the
    // latter was the shape that caused every paymentLedger row across
    // prod to look orphan.
    const paymentLedgerRows = await prisma.ledgerEntry.findMany({
      where: { garageId: gid, sourceType: "PAYMENT" },
      orderBy: { account: "asc" },
    });
    expect(paymentLedgerRows).toHaveLength(2);
    for (const row of paymentLedgerRows) {
      expect(row.sourceId).toBe(paymentId);
      expect(row.sourceId).not.toBe(inv.id);
    }

    // Amounts unchanged from the historical shape: DR Cash / CR AR
    // for the full payment amount.
    const cash = paymentLedgerRows.find((r) => r.account === "Cash/Bank");
    const ar = paymentLedgerRows.find((r) => r.account === "Accounts Receivable");
    expect(Number(cash!.debit)).toBe(100);
    expect(Number(cash!.credit)).toBe(0);
    expect(Number(ar!.debit)).toBe(0);
    expect(Number(ar!.credit)).toBe(100);
  });

  it("multi-payment invoice — each Payment gets its own uniquely-keyed ledger pair", async () => {
    const { inv } = await seedInvoice("300.00");

    await recordPaymentAction(form({ invoiceId: inv.id, amount: "100", method: "CASH" }));
    await recordPaymentAction(form({ invoiceId: inv.id, amount: "200", method: "CARD_POS" }));

    const payments = await prisma.payment.findMany({
      where: { invoiceId: inv.id }, orderBy: { paidAt: "asc" },
    });
    expect(payments).toHaveLength(2);

    // Four ledger rows total (two per payment). Group by sourceId —
    // each group must correspond to exactly one Payment.id and hold
    // exactly one DR Cash + one CR AR pair.
    const rows = await prisma.ledgerEntry.findMany({
      where: { garageId: gid, sourceType: "PAYMENT" },
    });
    expect(rows).toHaveLength(4);
    const paymentIds = new Set(payments.map((p) => p.id));
    const sourceIds = new Set(rows.map((r) => r.sourceId));
    expect(sourceIds).toEqual(paymentIds);
    // Every sourceId must be a real Payment.id (never the invoice id).
    for (const r of rows) {
      expect(r.sourceId).not.toBe(inv.id);
      expect(paymentIds.has(r.sourceId)).toBe(true);
    }
  });
});
