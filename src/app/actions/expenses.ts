"use server";

// Accounting E1c — expense actions (AR 2026-09-02).
//
// Two OWNER + MASTER actions:
//
//   recordExpenseAction — direct posting per AR's Q3: an expense IS
//   the cash-out event. No AP intermediary. One balanced ledger pair
//   posted inside the same tx as the Expense row:
//     DR <expense account>   amount
//     CR Cash/Bank           amount
//   sourceType='EXPENSE' (single type per AR's Q2 — category on the
//   Expense row, not in sourceType).
//
//   voidExpenseAction — marks Expense.status='VOID' and posts the
//   reversing pair. Same sourceType='EXPENSE' + sourceId=expense.id,
//   so the two pairs net to zero when reporting sums by source.

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

export async function recordExpenseAction(formData: FormData) {
    const user = await requireOperational();

    const categoryRaw = String(formData.get("category") ?? "").trim();
    const amountRaw = String(formData.get("amount") ?? "").trim();
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

    if (!amountRaw) fail("Missing expense amount.");
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
        fail("Expense amount must be a positive number.");
    }

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
                amount,
                paidAt,
                method,
                supplierId,
                note,
                attachmentUrl,
                status: "ACTIVE",
            },
        });

        // Direct posting — no AP intermediary per AR's Q3.
        // DR <expense account>   amount
        // CR Cash/Bank           amount
        await tx.ledgerEntry.createMany({
            data: [
                {
                    garageId: user.garageId,
                    account: expenseAccount,
                    debit: amount,
                    credit: 0,
                    sourceType: "EXPENSE",
                    sourceId: expense.id,
                },
                {
                    garageId: user.garageId,
                    account: ACCOUNTS.CASH,
                    debit: 0,
                    credit: amount,
                    sourceType: "EXPENSE",
                    sourceId: expense.id,
                },
            ],
        });
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
        select: { id: true, category: true, amount: true, status: true },
    });
    if (!expense) fail("Expense not found.");
    if (expense.status === "VOID") fail("Expense is already void.");

    const expenseAccount = CATEGORY_TO_ACCOUNT[expense.category];
    const amount = Number(expense.amount);

    await prisma.$transaction(async (tx) => {
        await tx.expense.update({
            where: { id: expenseId },
            data: { status: "VOID" },
        });

        // Reversing pair — same sourceType + sourceId as the original
        // per AR's Q2 (one source type per event class). Net across
        // the two pairs on this expense = 0 in the ledger.
        //   DR Cash/Bank           amount
        //   CR <expense account>   amount
        await tx.ledgerEntry.createMany({
            data: [
                {
                    garageId: user.garageId,
                    account: ACCOUNTS.CASH,
                    debit: amount,
                    credit: 0,
                    sourceType: "EXPENSE",
                    sourceId: expense.id,
                },
                {
                    garageId: user.garageId,
                    account: expenseAccount,
                    debit: 0,
                    credit: amount,
                    sourceType: "EXPENSE",
                    sourceId: expense.id,
                },
            ],
        });
    });

    revalidatePath("/owner/accounting/expenses");
    revalidatePath(`/owner/accounting/expenses/${expenseId}`);
    redirect(`/owner/accounting/expenses/${expenseId}`);
}
