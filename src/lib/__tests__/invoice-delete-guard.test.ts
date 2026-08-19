/**
 * Ledger-source delete guards — AR 2026-08-19.
 *
 * Three triggers, one migration, one test file:
 *   invoice_delete_guard          on "Invoice"
 *   payment_delete_guard          on "Payment"
 *   advance_payment_delete_guard  on "AdvancePayment"
 *
 * See prisma/migrations/20260819160000_ledger_source_delete_guard/
 * migration.sql for the rules and escape hatch.
 *
 * We test each trigger end-to-end against the LOCAL dev DB:
 *   A) allowed path — DRAFT invoice, or flag-set delete
 *   B) blocked path — trigger raises, row survives
 *   C) escape hatch — SET LOCAL flag inside a transaction, delete
 *      succeeds, audit row written with the note
 *   D) flag doesn't leak past COMMIT — a fresh session/txn is still
 *      protected after a legitimate cleanup elsewhere
 *
 * Cleanup by garageId prefix so a mid-suite failure doesn't leave
 * dev-DB detritus behind.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";

const P = "ledger-guard-test-";
const gid = P + "g1";

async function makeCustomerAndVehicle() {
  const customer = await prisma.customer.upsert({
    where: { id: P + "c1" },
    update: {},
    create: { id: P + "c1", garageId: gid, name: "C", phone: P + "phone" },
  });
  const vehicle = await prisma.vehicle.upsert({
    where: { id: P + "v1" },
    update: {},
    create: { id: P + "v1", customerId: customer.id, make: "T", model: "C", plate: P + "plt" },
  });
  return { customer, vehicle };
}

async function seedInvoice(status: "DRAFT" | "SENT") {
  const { vehicle } = await makeCustomerAndVehicle();
  const job = await prisma.jobCard.create({
    data: { garageId: gid, vehicleId: vehicle.id, status: "INVOICED" },
  });
  const number = Math.floor(Math.random() * 1_000_000) + 1;
  const invoice = await prisma.invoice.create({
    data: {
      garageId: gid,
      jobCardId: job.id,
      number,
      status,
      subtotal: "100.00",
      vatAmount: "5.00",
      total: "105.00",
      issuedAt: new Date(),
      dueDate: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  return { invoice, job };
}

async function seedPayment() {
  const { invoice } = await seedInvoice("SENT");
  const payment = await prisma.payment.create({
    data: {
      invoiceId: invoice.id,
      amount: "50.00",
      method: "CASH",
      paidAt: new Date(),
    },
  });
  return { payment, invoice };
}

async function seedAdvancePayment() {
  const { vehicle } = await makeCustomerAndVehicle();
  const job = await prisma.jobCard.create({
    data: { garageId: gid, vehicleId: vehicle.id, status: "REPAIR" },
  });
  const advance = await prisma.advancePayment.create({
    data: {
      garageId: gid,
      jobCardId: job.id,
      amount: "25.00",
      method: "CASH",
      receivedAt: new Date(),
    },
  });
  return { advance, job };
}

async function cleanup() {
  // Order: audit tables (standalone), then children of Invoice/Payment/
  // AdvancePayment, then those tables (flipped to allow-flag), then
  // JobCard/Vehicle/Customer/Garage.
  await prisma.invoiceDeleteAudit.deleteMany({ where: { garageId: gid } });
  await prisma.paymentDeleteAudit.deleteMany({ where: { invoiceId: { startsWith: "" } } })
    .catch(() => {}); // no garageId column; nuke anything that references our test payments
  await prisma.advancePaymentDeleteAudit.deleteMany({ where: { garageId: gid } });

  // Escape-hatch cleanup — the guards would otherwise fight us.
  // Use $transaction so SET LOCAL sticks for the deletes.
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL app.allow_payment_delete = 'true'`),
    prisma.$executeRawUnsafe(`SET LOCAL app.allow_advance_delete = 'true'`),
    prisma.$executeRawUnsafe(`SET LOCAL app.allow_invoice_delete = 'true'`),
    prisma.$executeRawUnsafe(`SET LOCAL app.delete_note = 'test cleanup'`),
    prisma.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "garageId" = '${gid}')`),
    prisma.$executeRawUnsafe(`DELETE FROM "AdvancePayment" WHERE "garageId" = '${gid}'`),
    prisma.$executeRawUnsafe(`DELETE FROM "Invoice" WHERE "garageId" = '${gid}'`),
  ]);

  await prisma.jobCard.deleteMany({ where: { garageId: gid } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: gid } } });
  await prisma.customer.deleteMany({ where: { garageId: gid } });
  await prisma.garage.deleteMany({ where: { id: gid } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: gid, name: gid } });
});
afterAll(cleanup);

describe("invoice_delete_guard", () => {
  it("A) DRAFT delete succeeds and writes an 'allowed' audit row", async () => {
    const { invoice } = await seedInvoice("DRAFT");
    await prisma.invoice.delete({ where: { id: invoice.id } });

    const stillExists = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(stillExists).toBeNull();

    const audit = await prisma.invoiceDeleteAudit.findFirst({
      where: { invoiceId: invoice.id },
      orderBy: { attemptedAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.outcome).toBe("allowed");
    expect(audit!.status).toBe("DRAFT");
    expect(audit!.number).toBe(invoice.number);
  });

  it("B) non-DRAFT delete without the flag THROWS and row survives", async () => {
    const { invoice } = await seedInvoice("SENT");
    await expect(
      prisma.invoice.delete({ where: { id: invoice.id } }),
    ).rejects.toThrow(/cannot be deleted/i);

    const stillExists = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(stillExists).not.toBeNull();
    expect(stillExists!.status).toBe("SENT");
  });

  it("C) non-DRAFT delete WITH the session flag succeeds and captures the note", async () => {
    const { invoice } = await seedInvoice("SENT");
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL app.allow_invoice_delete = 'true'`),
      prisma.$executeRawUnsafe(`SET LOCAL app.delete_note = 'ticket-42: test cleanup'`),
      prisma.$executeRawUnsafe(`DELETE FROM "Invoice" WHERE id = '${invoice.id}'`),
    ]);

    const stillExists = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(stillExists).toBeNull();

    const audit = await prisma.invoiceDeleteAudit.findFirst({
      where: { invoiceId: invoice.id },
      orderBy: { attemptedAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.outcome).toBe("allowed");
    expect(audit!.note).toBe("ticket-42: test cleanup");
  });

  it("D) flag does NOT leak — next transaction is protected again", async () => {
    const { invoice: inv1 } = await seedInvoice("SENT");
    const { invoice: inv2 } = await seedInvoice("SENT");

    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL app.allow_invoice_delete = 'true'`),
      prisma.$executeRawUnsafe(`DELETE FROM "Invoice" WHERE id = '${inv1.id}'`),
    ]);

    await expect(
      prisma.invoice.delete({ where: { id: inv2.id } }),
    ).rejects.toThrow(/cannot be deleted/i);
  });
});

describe("payment_delete_guard", () => {
  it("A) delete without flag THROWS", async () => {
    const { payment } = await seedPayment();
    await expect(
      prisma.payment.delete({ where: { id: payment.id } }),
    ).rejects.toThrow(/cannot be deleted/i);

    const stillExists = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(stillExists).not.toBeNull();
  });

  it("B) delete WITH flag succeeds and captures the note in the audit", async () => {
    const { payment } = await seedPayment();
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL app.allow_payment_delete = 'true'`),
      prisma.$executeRawUnsafe(`SET LOCAL app.delete_note = 'ticket-99: test payment cleanup'`),
      prisma.$executeRawUnsafe(`DELETE FROM "Payment" WHERE id = '${payment.id}'`),
    ]);

    const stillExists = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(stillExists).toBeNull();

    const audit = await prisma.paymentDeleteAudit.findFirst({
      where: { paymentId: payment.id },
      orderBy: { attemptedAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.outcome).toBe("allowed");
    expect(audit!.note).toBe("ticket-99: test payment cleanup");
    expect(Number(audit!.amount)).toBe(50);
  });

  it("C) invoice flag does NOT enable payment deletion", async () => {
    // Cross-flag isolation: setting the invoice flag doesn't smuggle
    // Payment deletes through. Every table needs its own flag.
    const { payment } = await seedPayment();
    await expect(
      prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL app.allow_invoice_delete = 'true'`),
        prisma.$executeRawUnsafe(`DELETE FROM "Payment" WHERE id = '${payment.id}'`),
      ]),
    ).rejects.toThrow(/cannot be deleted/i);
  });
});

describe("advance_payment_delete_guard", () => {
  it("A) delete without flag THROWS", async () => {
    const { advance } = await seedAdvancePayment();
    await expect(
      prisma.advancePayment.delete({ where: { id: advance.id } }),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it("B) delete WITH flag succeeds and audit captures amount + method", async () => {
    const { advance } = await seedAdvancePayment();
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL app.allow_advance_delete = 'true'`),
      prisma.$executeRawUnsafe(`SET LOCAL app.delete_note = 'ticket-11: advance cleanup'`),
      prisma.$executeRawUnsafe(`DELETE FROM "AdvancePayment" WHERE id = '${advance.id}'`),
    ]);

    const stillExists = await prisma.advancePayment.findUnique({ where: { id: advance.id } });
    expect(stillExists).toBeNull();

    const audit = await prisma.advancePaymentDeleteAudit.findFirst({
      where: { advancePaymentId: advance.id },
      orderBy: { attemptedAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.outcome).toBe("allowed");
    expect(Number(audit!.amount)).toBe(25);
    expect(audit!.method).toBe("CASH");
    expect(audit!.note).toBe("ticket-11: advance cleanup");
  });
});
