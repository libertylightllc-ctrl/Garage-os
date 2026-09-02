"use server";

// Accounting E1c + E1f — expense actions (AR 2026-09-02, VAT split
// added E1f the same day).
//
// Two OWNER + MASTER actions:
//
//   recordExpenseAction — direct posting per AR's Q3: an expense IS
//   the cash-out event. No AP intermediary. One balanced ledger post
//   inside the same tx as the Expense row.
//
//   Pre-E1f shape (single amount):
//     DR <expense account>   amount
//     CR Cash/Bank           amount
//
//   E1f shape (VAT split, rule 12 build trigger for E4):
//     DR <expense account>   subtotal
//     DR VAT Recoverable     vatAmount   [omitted when vatAmount = 0]
//     CR Cash/Bank           total
//
//   VAT defaults to zero (not auto-calc from Garage.vatRate) per
//   AR 2026-09-02 — auto-calc would silently claim reclaimable VAT
//   on SALARIES / BANK_CHARGES / any exempt-in-practice category,
//   corrupting Form 201 more than a missing entry does.
//
//   sourceType='EXPENSE' (single type per AR's Q2 — category on the
//   Expense row, not in sourceType).
//
//   voidExpenseAction — marks Expense.status='VOID' and posts the
//   reversing entries. Same sourceType='EXPENSE' + sourceId=expense.id
//   so the two posts net to zero when reporting sums by source.
//   Reverses the VAT row too when the original had one.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireOperational } from "@/lib/action-guards";
import { ACCOUNTS } from "@/lib/billing";
import { ExpenseCategory } from "@/generated/prisma/client";

function fail(msg: string, path = "/owner/accounting/expenses"): never {
    redirect(`${path}?error=${encodeURIComponent(msg)}`);
}

// Category → ledger account. Every ExpenseCategory enum value must
// map here; the type below makes an omission a compile error.
const CATEGORY_TO_ACCOUNT: Record<ExpenseCategory, string> = {
    RENT: ACCOUNTS.EXP_RENT,
    SALARIES: ACCOUNTS.EXP_SALARIES,
    UTILITIES: ACCOUNTS.EXP_UTILITIES,
    TOOLS: ACCOUNTS.EXP_TOOLS,
    VEHICLE: ACCOUNTS.EXP_VEHICLE,
    MARKETING: ACCOUNTS.EXP_MARKETING,
    BANK_CHARGES: ACCOUNTS.EXP_BANK_CHARGES,
    OFFICE: ACCOUNTS.EXP_OFFICE,
    REPAIRS_MAINT: ACCOUNTS.EXP_REPAIRS_MAINT,
    PROF_FEES: ACCOUNTS.EXP_PROF_FEES,
    MISC: ACCOUNTS.EXP_MISC,
};

const VALID_METHODS = ["Cash", "Bank Transfer", "Card", "Cheque", "Other"];

function isExpenseCategory(v: string): v is ExpenseCategory {
    return Object.prototype.hasOwnProperty.call(CATEGORY_TO_ACCOUNT, v);
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export async function recordExpenseAction(formData: FormData) {
    const user = await requireOperational();

    const categoryRaw = String(formData.get("category") ?? "").trim();
    // "total" replaces the old "amount" field name (E1f, migration
    // 20260902200000). The form still submits `amount` for backward
    // compatibility with any bookmarked/scripted flows — accept
    // either, prefer `total` when both are present.
    const totalRaw =
        String(formData.get("total") ?? "").trim() ||
        String(formData.get("amount") ?? "").trim();
    const vatAmountRaw = String(formData.get("vatAmount") ?? "").trim();
    const paidAtRaw = String(formData.get("paidAt") ?? "").trim();
    const method = String(formData.get("method") ?? "").trim();
    const noteRaw = String(formData.get("note") ?? "").trim();
    const supplierIdRaw = String(formData.get("supplierId") ?? "").trim();
    const attachmentUrlRaw = String(formData.get("attachmentUrl") ?? "").trim();

    if (!categoryRaw) fail("Missing expense category.");
    if (!isExpenseCategory(categoryRaw)) {
        fail(`Invalid expense category "${categoryRaw}".`);
    }
    const category: ExpenseCategory = categoryRaw;

    if (!totalRaw) fail("Missing expense amount.");
    const total = round2(Number(totalRaw));
    if (!Number.isFinite(total) || total <= 0) {
        fail("Expense amount must be a positive number.");
    }

    // VAT defaults to 0 when the input is blank — matches the form's
    // zero-default. An explicitly-entered 0 also lands here.
    const vatAmount = vatAmountRaw === "" ? 0 : round2(Number(vatAmountRaw));
    if (!Number.isFinite(vatAmount) || vatAmount < 0) {
        fail("VAT amount must be zero or a positive number.");
    }
    // Rule 12 invariant: total = subtotal + vatAmount. VAT can't be
    // more than the total — that's a data-entry error the client-side
    // counter should have caught, but the action refuses too so a
    // scripted / bookmarked submit doesn't slip through.
    if (vatAmount > total) {
        fail(
            `VAT amount (AED ${vatAmount.toFixed(2)}) can't be more than the total (AED ${total.toFixed(2)}).`,
        );
    }
    const subtotal = round2(total - vatAmount);

    if (!method) fail("Missing payment method.");
    if (!VALID_METHODS.includes(method)) {
        fail(`Invalid payment method. Choose one of: ${VALID_METHODS.join(", ")}.`);
    }

    // paidAt defaults to now — an expense recorded without a specific
    // date is "today." Rare in practice (the record form pre-fills
    // today's date), but the action needs to accept a blank.
    const paidAt = paidAtRaw ? new Date(paidAtRaw) : new Date();
    if (isNaN(paidAt.getTime())) fail("Expense date is not a valid date.");

    // Optional supplier — validate it belongs to this garage.
    let supplierId: string | null = null;
    if (supplierIdRaw !== "") {
        const s = await prisma.supplier.findFirst({
            where: { id: supplierIdRaw, garageId: user.garageId },
            select: { id: true },
        });
        if (!s) fail("Supplier not found for this garage.");
        supplierId = s.id;
    }

    const note = noteRaw === "" ? null : noteRaw;
    const attachmentUrl = attachmentUrlRaw === "" ? null : attachmentUrlRaw;
    const expenseAccount = CATEGORY_TO_ACCOUNT[category];

    await prisma.$transaction(async (tx) => {
        const expense = await tx.expense.create({
            data: {
                garageId: user.garageId,
                category,
                total,
                subtotal,
                vatAmount,
                paidAt,
                method,
                supplierId,
                note,
                attachmentUrl,
                status: "ACTIVE",
            },
        });

        // Direct posting per AR's Q3. VAT row conditionally added.
        //   DR <expense account>   subtotal
        //   DR VAT Recoverable     vatAmount   [when vatAmount > 0]
        //   CR Cash/Bank           total
        const rows = [
            {
                garageId: user.garageId,
                account: expenseAccount,
                debit: subtotal,
                credit: 0,
                sourceType: "EXPENSE",
                sourceId: expense.id,
            },
            {
                garageId: user.garageId,
                account: ACCOUNTS.CASH,
                debit: 0,
                credit: total,
                sourceType: "EXPENSE",
                sourceId: expense.id,
            },
        ];
        if (vatAmount > 0) {
            rows.push({
                garageId: user.garageId,
                account: ACCOUNTS.VAT_INPUT,
                debit: vatAmount,
                credit: 0,
                sourceType: "EXPENSE",
                sourceId: expense.id,
            });
        }
        await tx.ledgerEntry.createMany({ data: rows });
    });

    revalidatePath("/owner/accounting/expenses");
    redirect("/owner/accounting/expenses");
}

export async function voidExpenseAction(formData: FormData) {
    const user = await requireOperational();

    const expenseId = String(formData.get("expenseId") ?? "").trim();
    if (!expenseId) fail("Missing expense id.");

    const expense = await prisma.expense.findFirst({
        where: { id: expenseId, garageId: user.garageId },
        select: {
            id: true,
            category: true,
            total: true,
            subtotal: true,
            vatAmount: true,
            status: true,
        },
    });
    if (!expense) fail("Expense not found.");
    if (expense.status === "VOID") fail("Expense is already void.");

    const expenseAccount = CATEGORY_TO_ACCOUNT[expense.category];
    const total = Number(expense.total);
    const subtotal = Number(expense.subtotal);
    const vatAmount = Number(expense.vatAmount);

    await prisma.$transaction(async (tx) => {
        await tx.expense.update({
            where: { id: expenseId },
            data: { status: "VOID" },
        });

        // Reversing rows — mirror whatever the original wrote. Same
        // sourceType + sourceId per AR's Q2. Net across the two
        // posts on every account = 0.
        //   DR Cash/Bank           total
        //   CR <expense account>   subtotal
        //   CR VAT Recoverable     vatAmount   [when vatAmount > 0]
        const rows = [
            {
                garageId: user.garageId,
                account: ACCOUNTS.CASH,
                debit: total,
                credit: 0,
                sourceType: "EXPENSE",
                sourceId: expense.id,
            },
            {
                garageId: user.garageId,
                account: expenseAccount,
                debit: 0,
                credit: subtotal,
                sourceType: "EXPENSE",
                sourceId: expense.id,
            },
        ];
        if (vatAmount > 0) {
            rows.push({
                garageId: user.garageId,
                account: ACCOUNTS.VAT_INPUT,
                debit: 0,
                credit: vatAmount,
                sourceType: "EXPENSE",
                sourceId: expense.id,
            });
        }
        await tx.ledgerEntry.createMany({ data: rows });
    });

    revalidatePath("/owner/accounting/expenses");
    revalidatePath(`/owner/accounting/expenses/${expenseId}`);
    redirect(`/owner/accounting/expenses/${expenseId}`);
}
