// Payables (AR 2026-08-30) — bill creation + AP ledger post.
//
// Called from receivePurchaseOrderAction ONLY when
// garage.payablesEnabled === true. Runs inside the receive
// transaction — a throw here rolls back the entire receive
// (stock, PartMovement, POLine.receivedQty). That's deliberate:
// partial success (stock in, no bill) is worse than atomic
// failure the operator can retry. Same discipline as invoice
// generation.
//
// Legacy null-cost lines (pre-Layer-0) skip the bill's subtotal.
// If every accepted line has null unitCost, subtotal = 0 and no
// bill is created — the receive still lands, but AP stays out of
// it. Same "we don't fake missing cost" discipline as the
// dashboard Gross-profit tile.

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ACCOUNTS } from "@/lib/billing";

type TxClient = Omit<
    PrismaClient,
    "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export interface StockReceiptForBill {
    receiveNow: number;
    unitCost: Prisma.Decimal | number | null;
}
export interface DirectReceiptForBill {
    receiveNow: number;
    receivedUnitCost: number;
}

export interface CreateBillFromReceiveInput {
    garageId: string;
    supplierId: string;
    purchaseOrderId: string;
    /** Date printed on the supplier's tax invoice — captured on the
     * receive form (defaults to today; operator overrides to match
     * the paper). Aging clocks in C6 start from this date, not the
     * receive timestamp. */
    billDate: Date;
    /** Supplier's own invoice number from the paper. Optional; no
     * uniqueness — suppliers reuse numbers across years. Purpose:
     * match this row back to the supplier's paper when they query
     * a balance. */
    supplierInvoiceRef: string | null;
    /** Garage-wide VAT rate as a 4-dp decimal (0.05 = 5%). Reused from
     * Garage.vatRate — one legal VAT rate per country, no separate
     * purchase-side field. */
    vatRate: Prisma.Decimal | number;
    stockReceipts: StockReceiptForBill[];
    directReceipts: DirectReceiptForBill[];
    /** If set, replaces the auto-calc subtotal. Operator-typed to
     * reconcile a supplier bill that genuinely covers both stock
     * lines AND direct-fit lines from the same PO — the auto-calc
     * only counts stock (direct-fit never enters Inventory). Also
     * used when the supplier's tax invoice differs from the shop's
     * line-by-line math for any other reason. Blank = auto-calc.
     * See AR 2026-08-30 Q2. */
    subtotalOverride: number | null;
    /** If set, replaces the auto-calc VAT amount. Operator-typed on
     * the receive form to match the supplier's actual tax invoice
     * (rounding differences, exempt-item mixes). */
    vatAmountOverride: number | null;
    /** Ledger source-type tag for the DR/CR pair. Kept extension-
     * point-shaped in case a future adjustment flow reuses this
     * helper with a different source type. */
    sourceType?: string;
}

export interface CreatedBill {
    bill: {
        id: string;
        billNumber: number;
        subtotal: number;
        vatAmount: number;
        total: number;
    } | null;
    /** True when no bill was created because every accepted line lacked
     * unitCost. Caller may log / warn on this. */
    skippedNoCost: boolean;
}

function toNum(d: Prisma.Decimal | number | null | undefined): number {
    if (d === null || d === undefined) return 0;
    return typeof d === "number" ? d : Number(d);
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export async function createBillFromReceive(
    tx: TxClient,
    input: CreateBillFromReceiveInput,
): Promise<CreatedBill> {
    // Subtotal auto-calc — sum of STOCK lines' receiveNow × unitCost
    // ONLY. Direct-fit lines are deliberately excluded (AR 2026-08-30
    // Q2): they never enter Inventory, so DR Inventory for them would
    // be a false debit; and the direct-fit cost already flows through
    // the estimate/invoice line, where C4's COGS post captures it —
    // billing it again here would double-count into COGS at invoice
    // time. Stock lines with null unitCost contribute 0 (not
    // fabricated).
    //
    // If a supplier bill genuinely covers both stock AND direct-fit
    // parts (rare — one paper invoice for a mixed shipment), the
    // operator uses `subtotalOverride` on the receive form to enter
    // the supplier's actual total. That's a real-world reconciliation,
    // not something the app should guess.
    let autoSubtotal = 0;
    let anyStockCostedLine = false;
    for (const s of input.stockReceipts) {
        const cost = toNum(s.unitCost);
        if (cost > 0) {
            autoSubtotal += s.receiveNow * cost;
            anyStockCostedLine = true;
        }
    }
    autoSubtotal = round2(autoSubtotal);

    // Operator override wins when provided (non-null, non-negative).
    // Blank = use the auto-calc.
    const subtotal =
        input.subtotalOverride !== null && input.subtotalOverride >= 0
            ? round2(input.subtotalOverride)
            : autoSubtotal;

    if (subtotal === 0) {
        // Nothing to bill for — receive itself still lands (stock
        // moves, PartMovement rows written; direct-fit JobPartReceipt
        // rows written), but AP stays out. Direct-fit-only receives
        // land here (direct-fit doesn't count toward the stock
        // subtotal, and no operator override was supplied). Null-cost
        // stock lines with no override also land here.
        return { bill: null, skippedNoCost: true };
    }

    const vatFromRate = round2(subtotal * toNum(input.vatRate));
    const vatAmount =
        input.vatAmountOverride !== null && input.vatAmountOverride >= 0
            ? round2(input.vatAmountOverride)
            : vatFromRate;
    const total = round2(subtotal + vatAmount);

    // Allocate billNumber via the garage's counter — gapless
    // per-garage sequence, same discipline as invoiceSeq / jobSeq.
    // The increment + read is atomic inside the outer $transaction.
    const g = await tx.garage.update({
        where: { id: input.garageId },
        data: { billSeq: { increment: 1 } },
        select: { billSeq: true },
    });

    const bill = await tx.supplierBill.create({
        data: {
            garageId: input.garageId,
            supplierId: input.supplierId,
            purchaseOrderId: input.purchaseOrderId,
            billNumber: g.billSeq,
            billDate: input.billDate,
            supplierInvoiceRef: input.supplierInvoiceRef,
            subtotal,
            vatAmount,
            total,
            paidAmount: 0,
            status: "OPEN",
        },
        select: { id: true, billNumber: true, subtotal: true, vatAmount: true, total: true },
    });

    // Ledger post — three rows, one balanced entry:
    //   DR Inventory (subtotal)
    //   DR VAT-Input (vatAmount)     [omitted when vatAmount = 0]
    //   CR AP        (total)
    const sourceType = input.sourceType ?? "SUPPLIER_BILL";
    const rows: Prisma.LedgerEntryCreateManyInput[] = [
        {
            garageId: input.garageId,
            account: ACCOUNTS.INVENTORY,
            debit: subtotal,
            credit: 0,
            sourceType,
            sourceId: bill.id,
        },
    ];
    if (vatAmount > 0) {
        rows.push({
            garageId: input.garageId,
            account: ACCOUNTS.VAT_INPUT,
            debit: vatAmount,
            credit: 0,
            sourceType,
            sourceId: bill.id,
        });
    }
    rows.push({
        garageId: input.garageId,
        account: ACCOUNTS.AP,
        debit: 0,
        credit: total,
        sourceType,
        sourceId: bill.id,
    });
    await tx.ledgerEntry.createMany({ data: rows });

    return {
        bill: {
            id: bill.id,
            billNumber: bill.billNumber,
            subtotal: toNum(bill.subtotal),
            vatAmount: toNum(bill.vatAmount),
            total: toNum(bill.total),
        },
        skippedNoCost: false,
    };
}
