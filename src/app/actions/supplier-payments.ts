"use server";

// Payables C5 — supplier payments + bill voids.
//
// AR 2026-08-30. Two OWNER + MASTER actions:
//
//   recordSupplierPaymentAction — record one payment event to a
//   supplier, split across one or more open bills. Enforces three
//   invariants (per AR's C5 message):
//     1. SUM(allocations) === payment.amount. No on-account
//        balances. Refuse with a clear message rather than accept
//        a partial allocation.
//     2. Over-allocation blocked, checked INSIDE the tx. Two
//        concurrent payments against the same bill can't both pass.
//        Implemented via raw-SQL conditional UPDATE that guards
//        `paidAmount + amount <= total` — Prisma's updateMany
//        `where` can't do column-vs-column comparisons.
//     3. Per allocation: post one balanced ledger pair (DR AP /
//        CR CASH), sourceType='SUPPLIER_PAYMENT_ALLOCATION',
//        sourceId=allocation.id. Aging in C6 resolves DR AP
//        entries back to specific bills via that key.
//
//   voidSupplierBillAction — mark a SupplierBill VOID and post the
//   reversing ledger pair (DR AP / CR Inventory / CR VAT-Input),
//   sourceType='SUPPLIER_BILL_ADJUSTMENT'. Hard-refuses when the
//   bill has any allocated payment — the operator must correct
//   those first (real-world: supplier credit note, then this
//   proceeds). No `voidSupplierPaymentAction` yet — payment
//   corrections in MVP go via a compensating payment; the
//   refusal message says so.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireOperational } from "@/lib/action-guards";
import { ACCOUNTS } from "@/lib/billing";
// Runtime import (not `type`) — we construct Prisma.Decimal below for
// the raw-SQL parameter binding.
import { Prisma } from "@/generated/prisma/client";

function fail(msg: string, path = "/owner/payables"): never {
  redirect(`${path}?error=${encodeURIComponent(msg)}`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

class OverAllocationError extends Error {
  constructor(public billNumber: number, public attempted: number, public available: number) {
    super(
      `Over-allocation on bill #${billNumber}: attempted AED ${attempted.toFixed(
        2,
      )}, only AED ${available.toFixed(2)} outstanding.`,
    );
  }
}

class ConcurrentAllocationError extends Error {
  constructor(public billNumber: number) {
    super(
      `Bill #${billNumber} was updated by another payment while this one was being recorded. Reload and try again.`,
    );
  }
}

export async function recordSupplierPaymentAction(formData: FormData) {
  const user = await requireOperational();

  const supplierId = String(formData.get("supplierId") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const method = String(formData.get("method") ?? "").trim();
  const noteRaw = String(formData.get("note") ?? "").trim();
  const paidAtRaw = String(formData.get("paidAt") ?? "").trim();

  if (!supplierId) fail("Missing supplier.");
  if (!amountRaw) fail("Missing payment amount.");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0)
    fail("Payment amount must be a positive number.");
  if (!method) fail("Missing payment method.");

  const paidAt = paidAtRaw ? new Date(paidAtRaw) : new Date();
  if (isNaN(paidAt.getTime())) fail("Payment date is not a valid date.");

  // Parse allocations from formData. Any field named `alloc_<billId>`
  // with a non-empty positive value counts. Blank / zero entries are
  // skipped (an operator leaving a bill's row blank means "don't
  // allocate to that bill").
  const allocations: { billId: string; amount: number }[] = [];
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith("alloc_")) continue;
    const billId = k.slice("alloc_".length);
    const raw = String(v ?? "").trim();
    if (raw === "") continue;
    const allocAmount = Number(raw);
    if (!Number.isFinite(allocAmount) || allocAmount < 0)
      fail(`Allocation to a bill must be a non-negative number (got ${raw}).`);
    if (allocAmount === 0) continue;
    allocations.push({ billId, amount: allocAmount });
  }

  if (allocations.length === 0)
    fail(
      "No allocations provided. A supplier payment must allocate to at least one bill — no on-account balances.",
    );

  // Invariant 1: SUM(allocations) === payment amount.
  const allocSum = round2(allocations.reduce((s, a) => s + a.amount, 0));
  if (allocSum !== round2(amount)) {
    fail(
      `Allocation total (AED ${allocSum.toFixed(2)}) doesn't match payment amount (AED ${amount.toFixed(
        2,
      )}). Allocate the full amount across bills — no on-account balances.`,
    );
  }

  // Supplier + garage scope check (also gives us the display name for
  // the redirect message when things go wrong).
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, garageId: user.garageId },
    select: { id: true },
  });
  if (!supplier) fail("Supplier not found for this garage.");

  // Pre-fetch bills to verify they're OPEN/PARTIAL + belong to this
  // supplier. The atomic over-allocation check happens inside the tx
  // via raw SQL — this pre-fetch is just for a friendly upfront error.
  const bills = await prisma.supplierBill.findMany({
    where: {
      id: { in: allocations.map((a) => a.billId) },
      garageId: user.garageId,
      supplierId,
    },
    select: { id: true, billNumber: true, total: true, paidAmount: true, status: true },
  });
  const billsById = new Map(bills.map((b) => [b.id, b]));
  for (const alloc of allocations) {
    const bill = billsById.get(alloc.billId);
    if (!bill) {
      fail(
        `Bill not found or not from this supplier. Reload and pick from the list.`,
      );
    }
    if (bill.status !== "OPEN" && bill.status !== "PARTIALLY_PAID") {
      fail(
        `Bill #${bill.billNumber} is ${bill.status.toLowerCase()} — you can only pay OPEN or PARTIALLY_PAID bills.`,
      );
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.create({
        data: {
          garageId: user.garageId,
          supplierId,
          amount,
          method,
          paidAt,
          note: noteRaw === "" ? null : noteRaw,
        },
      });

      for (const alloc of allocations) {
        // Invariant 2 — atomic over-allocation guard. Raw SQL because
        // Prisma updateMany's `where` can't do column-vs-column
        // comparisons ("paidAmount + alloc <= total"). If a
        // concurrent payment bumped paidAmount past the cap between
        // the pre-fetch above and this write, the WHERE fails and
        // rows-affected returns 0 — we throw + roll back.
        //
        // Same query also transitions status inline: PAID when
        // paidAmount + alloc reaches total, PARTIALLY_PAID otherwise.
        // The CASE runs against the OLD paidAmount + alloc since the
        // SET clause reads pre-write column values.
        const rowsAffected = await tx.$executeRaw`
          UPDATE "SupplierBill"
          SET "paidAmount" = "paidAmount" + ${new Prisma.Decimal(alloc.amount)},
              "status" = CASE
                  WHEN "paidAmount" + ${new Prisma.Decimal(alloc.amount)} >= "total"
                      THEN 'PAID'::"SupplierBillStatus"
                  ELSE 'PARTIALLY_PAID'::"SupplierBillStatus"
              END,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${alloc.billId}
            AND "garageId" = ${user.garageId}
            AND "supplierId" = ${supplierId}
            AND "status" IN ('OPEN'::"SupplierBillStatus", 'PARTIALLY_PAID'::"SupplierBillStatus")
            AND "paidAmount" + ${new Prisma.Decimal(alloc.amount)} <= "total"
        `;
        if (rowsAffected === 0) {
          const bill = billsById.get(alloc.billId)!;
          const outstanding = Number(bill.total) - Number(bill.paidAmount);
          if (alloc.amount > outstanding) {
            throw new OverAllocationError(bill.billNumber, alloc.amount, outstanding);
          }
          throw new ConcurrentAllocationError(bill.billNumber);
        }

        const allocationRow = await tx.supplierPaymentAllocation.create({
          data: {
            supplierPaymentId: payment.id,
            supplierBillId: alloc.billId,
            amount: alloc.amount,
          },
        });

        // Ledger pair — DR AP / CR CASH, keyed to allocation.id so
        // the aging query in C6 can resolve each AP credit back to
        // the specific bill via the allocation → bill join.
        await tx.ledgerEntry.createMany({
          data: [
            {
              garageId: user.garageId,
              account: ACCOUNTS.AP,
              debit: alloc.amount,
              credit: 0,
              sourceType: "SUPPLIER_PAYMENT_ALLOCATION",
              sourceId: allocationRow.id,
            },
            {
              garageId: user.garageId,
              account: ACCOUNTS.CASH,
              debit: 0,
              credit: alloc.amount,
              sourceType: "SUPPLIER_PAYMENT_ALLOCATION",
              sourceId: allocationRow.id,
            },
          ],
        });
      }
    });
  } catch (e) {
    if (e instanceof OverAllocationError) {
      fail(e.message);
    }
    if (e instanceof ConcurrentAllocationError) {
      fail(e.message);
    }
    throw e;
  }

  revalidatePath("/owner/payables");
  redirect("/owner/payables");
}

export async function voidSupplierBillAction(formData: FormData) {
  const user = await requireOperational();
  const billId = String(formData.get("billId") ?? "").trim();
  if (!billId) fail("Missing bill id.");

  const bill = await prisma.supplierBill.findFirst({
    where: { id: billId, garageId: user.garageId },
    include: {
      allocations: {
        select: {
          amount: true,
          supplierPayment: {
            select: {
              id: true,
              paidAt: true,
              method: true,
              amount: true,
            },
          },
        },
      },
    },
  });
  if (!bill) fail("Bill not found.");
  if (bill.status === "VOID") fail("Bill is already void.");

  // Void-with-payments hard block (AR 2026-08-30 C5). Name the
  // payments so the operator can find them. Correction path is to
  // reverse those payments first (post-MVP action); for now, the
  // shop contacts the supplier for a credit note and records a
  // compensating negative-amount bill (also not yet wired — the
  // refusal is honest about the current gap).
  if (bill.allocations.length > 0) {
    const list = bill.allocations
      .map((a) => {
        const d = a.supplierPayment.paidAt.toISOString().slice(0, 10);
        return `${d} ${a.supplierPayment.method} AED ${Number(a.amount).toFixed(2)}`;
      })
      .join("; ");
    fail(
      `Bill #${bill.billNumber} has ${bill.allocations.length} allocated payment(s): ${list}. Void or reverse those payments first — this action never unwinds a paid bill silently.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.supplierBill.update({
      where: { id: billId },
      data: { status: "VOID" },
    });

    // Reversing ledger pair — mirror the original DR Inventory +
    // DR VAT-Input / CR AP with signs flipped. sourceType named
    // per AR 2026-08-30 Q1 so returns / voids stay distinct from
    // fresh bills at ledger-report time. Same discipline as
    // INVOICE_VOID.
    const rows: Prisma.LedgerEntryCreateManyInput[] = [
      {
        garageId: user.garageId,
        account: ACCOUNTS.AP,
        debit: bill.total,
        credit: 0,
        sourceType: "SUPPLIER_BILL_ADJUSTMENT",
        sourceId: bill.id,
      },
      {
        garageId: user.garageId,
        account: ACCOUNTS.INVENTORY,
        debit: 0,
        credit: bill.subtotal,
        sourceType: "SUPPLIER_BILL_ADJUSTMENT",
        sourceId: bill.id,
      },
    ];
    if (Number(bill.vatAmount) > 0) {
      rows.push({
        garageId: user.garageId,
        account: ACCOUNTS.VAT_INPUT,
        debit: 0,
        credit: bill.vatAmount,
        sourceType: "SUPPLIER_BILL_ADJUSTMENT",
        sourceId: bill.id,
      });
    }
    await tx.ledgerEntry.createMany({ data: rows });
  });

  revalidatePath("/owner/payables");
  redirect("/owner/payables");
}
