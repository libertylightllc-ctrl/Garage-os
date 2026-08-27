// ERPNext master-data pushers — Customer + Item.
//
// Each pusher follows the same three-step contract:
//   1. Pre-flight: findByGarageosId(). If HIT, log distinctly and
//      return the existing erpnextName without POST. This is the
//      idempotency safeguard from §3 of the brief — a duplicate
//      push cannot create a second row.
//   2. POST if absent. Frappe returns the created row's name.
//   3. Read back and (for records with Company defaults) verify the
//      §3 config asserts. On mismatch throw; the runner reclassifies
//      the job as FAILED.
//
// The pushers themselves do NOT open a Prisma transaction. The
// runner opens ONE $transaction around (entity-map upsert + job
// status update) AFTER the pusher returns. That keeps the HTTP call
// outside the DB tx — see runner.ts head comment.
//
// Item is READ-ONLY. §6 of the brief: the four generic Items
// (PART/LABOR/SUBLET/FEE) are pre-seeded on the instance and their
// item_code equals the GarageOS LineKind verbatim. We never create
// or update Items from Phase 3; verifyItemExists() is the safety
// check that they're actually there.

import { frappeGet, frappePost, findByGarageosId } from "@/lib/erp-sync/client";
import type { ErpNextCredentials } from "@/lib/erp-sync/credentials";

// Company-scoped account-name templates. Every account we route to
// takes the form `<template> - <companyAbbr>` (§3 of the brief).
// Callers concatenate with creds.companyAbbr at push time — see
// pushInvoice / pushPayment / pushAdvance below.
export const ACCOUNT_TEMPLATES = {
    // Every Sales Invoice line's income_account (AR 2026-08-27 Q1):
    // one revenue account, do not split by product line. Matches the
    // GarageOS ledger which has one Sales Revenue account.
    SALES: "Sales Account",
    // VAT taxes[] row account_head.
    VAT: "VAT 5%",
    // Payment Entry.paid_to (money in).
    CASH_BANK: "Cash/Bank",
    // Payment Entry.paid_from for invoice payments (money out of AR).
    RECEIVABLE: "Trade Receivable",
    // Payment Entry.paid_from for ADVANCES gets rewritten by ERPNext
    // to Customer Deposits when book_advance_payments_in_separate_
    // party_account = 1 on the Company. Callers still SEND "Trade
    // Receivable"; §5a check 1 asserts ERPNext rewrote it.
    CUSTOMER_DEPOSITS: "Customer Deposits",
} as const;

function acct(template: string, abbr: string): string {
    return `${template} - ${abbr}`;
}

export type PushResult = {
    erpnextName: string;
    /**
     * True when the entity was found on ERPNext by pre-flight (no
     * POST issued). Callers should log distinctly — this is the
     * signal that a prior push landed but its map/status commit
     * didn't complete.
     */
    preflightHit: boolean;
};

/**
 * Push a GarageOS Customer into ERPNext.
 *
 * Load-bearing: the custom field `garageos_customer_id` on Customer
 * carries our cuid; Selling Settings has `cust_master_name =
 * "Naming Series"` so ERPNext-side names are naming-series generated
 * (CUST-YYYY-#####). We NEVER match on customer_name — see §6 of
 * the brief.
 */
export async function pushCustomer(
    creds: ErpNextCredentials,
    customer: {
        id: string;
        name: string;
        phone: string | null;
        trn: string | null;
    },
    opts?: { fetchImpl?: typeof fetch },
): Promise<PushResult> {
    const existing = await findByGarageosId(
        creds,
        "Customer",
        "garageos_customer_id",
        customer.id,
        opts,
    );
    if (existing) {
        return { erpnextName: existing, preflightHit: true };
    }

    const body = await frappePost(
        creds,
        "/api/resource/Customer",
        {
            customer_name: customer.name,
            customer_type: "Individual",
            customer_group: "All Customer Groups",
            territory: "All Territories",
            // The load-bearing custom field. A duplicate push would
            // fail at the ERPNext-side unique index on this column
            // (§3 of the brief).
            garageos_customer_id: customer.id,
            // Optional extras — Customer's contact block. Frappe
            // accepts these but stores them on child tables, so the
            // read-back below only asserts the top-level fields.
            ...(customer.phone ? { mobile_no: customer.phone } : {}),
            ...(customer.trn ? { tax_id: customer.trn } : {}),
        },
        opts,
    );

    const name = extractName(body, "Customer");

    // Light read-back: verify the record exists and echoes our id.
    // Full §5-shape asserts land in Phase 5 for Sales Invoice. For
    // Customer + Item, matching the round-trip is sufficient.
    const readBack = await frappeGet(
        creds,
        `/api/resource/Customer/${encodeURIComponent(name)}`,
        undefined,
        opts,
    );
    const echoed = readBackField(readBack, "garageos_customer_id");
    if (echoed !== customer.id) {
        throw new Error(
            `[erp-pusher] Customer ${name} read-back returned garageos_customer_id=${echoed}, expected ${customer.id}`,
        );
    }

    return { erpnextName: name, preflightHit: false };
}

/**
 * Verify that the four generic Items exist on the instance and
 * return their names. Called once at runner startup per garage;
 * throws loudly if any is missing. §6 of the brief: the four are
 * pre-seeded and their item_code equals the LineKind — so the map
 * is identity, no lookup table needed at runtime.
 */
export async function verifyItemsExist(
    creds: ErpNextCredentials,
    opts?: { fetchImpl?: typeof fetch },
): Promise<{ kind: string; itemCode: string; name: string }[]> {
    const KINDS = ["PART", "LABOR", "SUBLET", "FEE"];
    const results: { kind: string; itemCode: string; name: string }[] = [];
    for (const kind of KINDS) {
        const body = await frappeGet(
            creds,
            `/api/resource/Item/${encodeURIComponent(kind)}`,
            undefined,
            opts,
        );
        const name = extractName(body, "Item");
        if (name !== kind) {
            throw new Error(
                `[erp-pusher] Item ${kind} — expected name to equal item_code, got ${name}`,
            );
        }
        results.push({ kind, itemCode: kind, name });
    }
    return results;
}

function extractName(body: unknown, doctype: string): string {
    if (!body || typeof body !== "object") {
        throw new Error(`[erp-pusher] ${doctype} — no body from Frappe`);
    }
    const data = (body as { data?: unknown }).data;
    if (!data || typeof data !== "object") {
        throw new Error(`[erp-pusher] ${doctype} — no data in body`);
    }
    const name = (data as { name?: unknown }).name;
    if (typeof name !== "string" || !name) {
        throw new Error(`[erp-pusher] ${doctype} — no name in data`);
    }
    return name;
}

function readBackField(body: unknown, field: string): unknown {
    if (!body || typeof body !== "object") return undefined;
    const data = (body as { data?: unknown }).data;
    if (!data || typeof data !== "object") return undefined;
    return (data as Record<string, unknown>)[field];
}

// ─────────────────────────────────────────────────────────────────
// Sales Invoice, Payment, Advance, Void
// ─────────────────────────────────────────────────────────────────

export type InvoicePushInput = {
    id: string;
    total: number;
    vatAmount: number;
    issuedAt: Date;
    dueDate: Date;
    customerErpnextName: string; // resolved from ErpEntityMap by runner
    /** Sum of already-taken deposits GarageOS knows about, in currency units. */
    expectedAllocation: number;
    // Lines carry qty + unitPrice; ERPNext computes subtotal from
    // qty × rate. We deliberately do NOT carry a subtotal on the
    // input (AR 2026-08-27 Q1) — sending amounts that ERPNext
    // ignores is misleading to anyone reading the payload later.
    lines: Array<{
        kind: string; // LineKind → also the item_code on ERPNext side (§6)
        description: string;
        qty: number;
        unitPrice: number;
    }>;
};

/**
 * Push a Sales Invoice.
 *
 * Shape from §4 of the brief:
 *   - items[].income_account = "Sales Account - <ABBR>" (AR Q1: one
 *     revenue account, no per-item split).
 *   - taxes[]: single row, charge_type = "Actual", exact tax_amount.
 *     ERPNext does not recompute — our per-line rounding is preserved.
 *   - disable_rounded_total = 1 — otherwise ERPNext books the
 *     rounding difference to a Round Off account we don't have.
 *   - allocate_advances_automatically = 1 — the per-document flag,
 *     asserted on read-back (§5b).
 *   - garageos_invoice_id = <our id> — the load-bearing custom field
 *     that backstops idempotency via ERPNext's unique index.
 *
 * §5b read-back asserts:
 *   1. docstatus == 1
 *   2. grand_total == our total (to the cent)
 *   3. taxes[0].tax_amount == our vatAmount
 *   4. allocate_advances_automatically == 1
 *   5. Outcome: outstanding_amount == grand_total - expectedAllocation.
 *      This is the decisive check per §5b — the flag can persist
 *      while the allocation still fails to occur.
 */
export async function pushInvoice(
    creds: ErpNextCredentials,
    inv: InvoicePushInput,
    opts?: { fetchImpl?: typeof fetch },
): Promise<PushResult> {
    const existing = await findByGarageosId(
        creds,
        "Sales Invoice",
        "garageos_invoice_id",
        inv.id,
        opts,
    );
    if (existing) {
        return { erpnextName: existing, preflightHit: true };
    }

    const salesAcct = acct(ACCOUNT_TEMPLATES.SALES, creds.companyAbbr);
    const vatAcct = acct(ACCOUNT_TEMPLATES.VAT, creds.companyAbbr);

    const body = await frappePost(
        creds,
        "/api/resource/Sales Invoice",
        {
            customer: inv.customerErpnextName,
            posting_date: ymd(inv.issuedAt),
            due_date: ymd(inv.dueDate),
            company: creds.companyName,
            items: inv.lines.map((l) => ({
                item_code: l.kind,
                description: l.description,
                qty: l.qty,
                rate: l.unitPrice,
                income_account: salesAcct,
            })),
            taxes: [
                {
                    charge_type: "Actual",
                    account_head: vatAcct,
                    tax_amount: inv.vatAmount,
                    description: "VAT 5%",
                },
            ],
            disable_rounded_total: 1,
            allocate_advances_automatically: 1,
            garageos_invoice_id: inv.id,
            is_pos: 0,
            docstatus: 1, // submit on save; draft-then-submit adds a round trip
        },
        opts,
    );

    const name = extractName(body, "Sales Invoice");
    await assertInvoiceReadBack(creds, name, inv, opts);
    return { erpnextName: name, preflightHit: false };
}

async function assertInvoiceReadBack(
    creds: ErpNextCredentials,
    name: string,
    inv: InvoicePushInput,
    opts?: { fetchImpl?: typeof fetch },
): Promise<void> {
    const readBack = await frappeGet(
        creds,
        `/api/resource/Sales Invoice/${encodeURIComponent(name)}`,
        undefined,
        opts,
    );

    const docstatus = readBackField(readBack, "docstatus");
    if (docstatus !== 1) {
        throw new Error(
            `[erp-pusher] Sales Invoice ${name}: docstatus=${docstatus}, expected 1 (submitted)`,
        );
    }

    const grandTotal = num(readBackField(readBack, "grand_total"));
    if (!eqCents(grandTotal, inv.total)) {
        throw new Error(
            `[erp-pusher] Sales Invoice ${name}: grand_total=${grandTotal}, expected ${inv.total}`,
        );
    }

    const flag = readBackField(readBack, "allocate_advances_automatically");
    // Frappe returns 1 for true, sometimes as number, sometimes as
    // string. §5b — the decisive per-document check.
    if (Number(flag) !== 1) {
        throw new Error(
            `[erp-pusher] Sales Invoice ${name}: allocate_advances_automatically=${flag}, expected 1`,
        );
    }

    const outstanding = num(readBackField(readBack, "outstanding_amount"));
    const expectedOutstanding = round2(inv.total - inv.expectedAllocation);
    if (!eqCents(outstanding, expectedOutstanding)) {
        // The most important failure surface — a deposit didn't
        // apply. Runner reclassifies to FAILED with the field named
        // in lastErrorField.
        const err = new Error(
            `[erp-pusher] Sales Invoice ${name}: outstanding_amount=${outstanding}, expected ${expectedOutstanding} (grand_total ${inv.total} - allocated ${inv.expectedAllocation}). A deposit is present in GarageOS but not applied on the ERPNext side.`,
        );
        (err as Error & { field?: string }).field = "outstanding_amount";
        throw err;
    }

    const taxes = readBackField(readBack, "taxes");
    if (!Array.isArray(taxes) || taxes.length === 0) {
        throw new Error(
            `[erp-pusher] Sales Invoice ${name}: taxes[] empty`,
        );
    }
    const vatRow = taxes[0] as Record<string, unknown>;
    const taxAmount = num(vatRow.tax_amount);
    if (!eqCents(taxAmount, inv.vatAmount)) {
        throw new Error(
            `[erp-pusher] Sales Invoice ${name}: taxes[0].tax_amount=${taxAmount}, expected ${inv.vatAmount}`,
        );
    }
}

// ─────────────────────────────────────────────────────────────────

export type PaymentPushInput = {
    id: string;
    amount: number;
    paidAt: Date;
    /** ERPNext-side name of the invoice this payment applies to. */
    invoiceErpnextName: string;
    customerErpnextName: string;
};

/**
 * Push a Payment against an existing Sales Invoice.
 *
 * Ledger shape from §4:
 *   DR Cash/Bank - GOS
 *   CR Trade Receivable - GOS  (party)
 * with references[] linking the Sales Invoice.
 *
 * Payment method (CASH / CARD_POS) is deliberately NOT pushed
 * (AR 2026-08-27 Q3). The GarageOS ledger collapses to one
 * Cash/Bank account regardless of instrument; ERPNext receives
 * that same shape. If an accountant later wants the split, that
 * is a mapping change and a new account, not a Payment field to
 * preserve.
 */
export async function pushPayment(
    creds: ErpNextCredentials,
    pay: PaymentPushInput,
    opts?: { fetchImpl?: typeof fetch },
): Promise<PushResult> {
    const existing = await findByGarageosId(
        creds,
        "Payment Entry",
        "garageos_payment_id",
        pay.id,
        opts,
    );
    if (existing) {
        return { erpnextName: existing, preflightHit: true };
    }

    const body = await frappePost(
        creds,
        "/api/resource/Payment Entry",
        {
            payment_type: "Receive",
            party_type: "Customer",
            party: pay.customerErpnextName,
            paid_amount: pay.amount,
            received_amount: pay.amount,
            posting_date: ymd(pay.paidAt),
            company: creds.companyName,
            paid_from: acct(ACCOUNT_TEMPLATES.RECEIVABLE, creds.companyAbbr),
            paid_to: acct(ACCOUNT_TEMPLATES.CASH_BANK, creds.companyAbbr),
            references: [
                {
                    reference_doctype: "Sales Invoice",
                    reference_name: pay.invoiceErpnextName,
                    allocated_amount: pay.amount,
                },
            ],
            garageos_payment_id: pay.id,
            docstatus: 1,
        },
        opts,
    );

    const name = extractName(body, "Payment Entry");
    await assertPaymentReadBack(creds, name, pay, opts);
    return { erpnextName: name, preflightHit: false };
}

async function assertPaymentReadBack(
    creds: ErpNextCredentials,
    name: string,
    pay: PaymentPushInput,
    opts?: { fetchImpl?: typeof fetch },
): Promise<void> {
    const readBack = await frappeGet(
        creds,
        `/api/resource/Payment Entry/${encodeURIComponent(name)}`,
        undefined,
        opts,
    );
    const docstatus = readBackField(readBack, "docstatus");
    if (docstatus !== 1) {
        throw new Error(
            `[erp-pusher] Payment Entry ${name}: docstatus=${docstatus}, expected 1`,
        );
    }
    const refs = readBackField(readBack, "references");
    if (!Array.isArray(refs) || refs.length === 0) {
        throw new Error(
            `[erp-pusher] Payment Entry ${name}: references[] empty — the payment would post but the invoice would stay open`,
        );
    }
    const refName = (refs[0] as Record<string, unknown>).reference_name;
    if (refName !== pay.invoiceErpnextName) {
        throw new Error(
            `[erp-pusher] Payment Entry ${name}: references[0].reference_name=${refName}, expected ${pay.invoiceErpnextName}`,
        );
    }
}

// ─────────────────────────────────────────────────────────────────

export type AdvancePushInput = {
    id: string;
    amount: number;
    receivedAt: Date;
    customerErpnextName: string;
};

/**
 * Push an Advance Payment (deposit taken before invoice).
 *
 * Ledger shape from §4:
 *   DR Cash/Bank - GOS
 *   CR Customer Deposits - GOS  (party)
 * with NO references[] rows (naked advance).
 *
 * We SEND paid_from = "Trade Receivable" — ERPNext rewrites it to
 * "Customer Deposits" on save because Company has
 * `book_advance_payments_in_separate_party_account = 1`
 * (§3 of the brief). The read-back asserts the rewrite happened;
 * §5a — the decisive check is the Payment Ledger Entry row, which
 * §3 called out as the invisible-failure surface.
 */
export async function pushAdvance(
    creds: ErpNextCredentials,
    adv: AdvancePushInput,
    opts?: { fetchImpl?: typeof fetch },
): Promise<PushResult> {
    const existing = await findByGarageosId(
        creds,
        "Payment Entry",
        "garageos_payment_id",
        adv.id,
        opts,
    );
    if (existing) {
        return { erpnextName: existing, preflightHit: true };
    }

    const body = await frappePost(
        creds,
        "/api/resource/Payment Entry",
        {
            payment_type: "Receive",
            party_type: "Customer",
            party: adv.customerErpnextName,
            paid_amount: adv.amount,
            received_amount: adv.amount,
            posting_date: ymd(adv.receivedAt),
            company: creds.companyName,
            // Sent as Receivable; ERPNext rewrites to Customer
            // Deposits. §5a check 1 asserts the rewrite.
            paid_from: acct(ACCOUNT_TEMPLATES.RECEIVABLE, creds.companyAbbr),
            paid_to: acct(ACCOUNT_TEMPLATES.CASH_BANK, creds.companyAbbr),
            // NO references — this is a naked advance.
            garageos_payment_id: adv.id,
            docstatus: 1,
        },
        opts,
    );

    const name = extractName(body, "Payment Entry");
    await assertAdvanceReadBack(creds, name, opts);
    return { erpnextName: name, preflightHit: false };
}

async function assertAdvanceReadBack(
    creds: ErpNextCredentials,
    name: string,
    opts?: { fetchImpl?: typeof fetch },
): Promise<void> {
    const readBack = await frappeGet(
        creds,
        `/api/resource/Payment Entry/${encodeURIComponent(name)}`,
        undefined,
        opts,
    );
    const docstatus = readBackField(readBack, "docstatus");
    if (docstatus !== 1) {
        throw new Error(
            `[erp-pusher] Advance ${name}: docstatus=${docstatus}, expected 1`,
        );
    }

    // §5a check 1 — routing happened.
    const paidFrom = readBackField(readBack, "paid_from");
    const expectedFrom = acct(ACCOUNT_TEMPLATES.CUSTOMER_DEPOSITS, creds.companyAbbr);
    if (paidFrom !== expectedFrom) {
        throw new Error(
            `[erp-pusher] Advance ${name}: paid_from=${paidFrom}, expected ${expectedFrom} (Company's book_advance_payments_in_separate_party_account may not be set)`,
        );
    }

    // §5a check 3 (the decisive one) — a Payment Ledger Entry row
    // for this voucher against Customer Deposits. Without it, the
    // deposit is unallocable forever and nothing errors.
    const pleFilters = JSON.stringify([
        ["voucher_no", "=", name],
        ["account", "=", expectedFrom],
    ]);
    const ple = await frappeGet(
        creds,
        "/api/resource/Payment Ledger Entry",
        { filters: pleFilters, limit_page_length: 1 },
        opts,
    );
    const pleData = (ple as { data?: unknown[] }).data;
    if (!Array.isArray(pleData) || pleData.length === 0) {
        const err = new Error(
            `[erp-pusher] Advance ${name}: NO Payment Ledger Entry row against ${expectedFrom}. §5a decisive check — the deposit is invisible-broken and cannot be applied to any invoice.`,
        );
        (err as Error & { field?: string }).field = "payment_ledger_entry";
        throw err;
    }
}

// ─────────────────────────────────────────────────────────────────

export type VoidPushInput = {
    /** Our original Invoice.id (also the source doc for the void job). */
    originalInvoiceId: string;
    /** ERPNext-side name of the original Sales Invoice (via ErpEntityMap). */
    originalErpnextName: string;
    total: number;
    vatAmount: number;
    voidedAt: Date;
    customerErpnextName: string;
    // As in InvoicePushInput — no subtotal; ERPNext computes.
    lines: Array<{
        kind: string;
        description: string;
        qty: number;
        unitPrice: number;
    }>;
};

/**
 * Push a credit note (void). §4 of the brief:
 *   Sales Invoice with is_return = 1 and return_against pointing at
 *   the original. NEVER the Cancel action — Cancel reverses the GL
 *   but produces no tax document; UAE VAT requires a credit note.
 *
 * Idempotency key: `garageos_credit_note_id = <original invoice.id>`.
 * A separate custom field from garageos_invoice_id so the unique
 * index on the latter doesn't conflict.
 */
export async function pushVoid(
    creds: ErpNextCredentials,
    v: VoidPushInput,
    opts?: { fetchImpl?: typeof fetch },
): Promise<PushResult> {
    const existing = await findByGarageosId(
        creds,
        "Sales Invoice",
        "garageos_credit_note_id",
        v.originalInvoiceId,
        opts,
    );
    if (existing) {
        return { erpnextName: existing, preflightHit: true };
    }

    const salesAcct = acct(ACCOUNT_TEMPLATES.SALES, creds.companyAbbr);
    const vatAcct = acct(ACCOUNT_TEMPLATES.VAT, creds.companyAbbr);

    const body = await frappePost(
        creds,
        "/api/resource/Sales Invoice",
        {
            customer: v.customerErpnextName,
            posting_date: ymd(v.voidedAt),
            due_date: ymd(v.voidedAt),
            company: creds.companyName,
            is_return: 1,
            return_against: v.originalErpnextName,
            items: v.lines.map((l) => ({
                item_code: l.kind,
                description: l.description,
                // Credit note quantities are negative in ERPNext.
                qty: -l.qty,
                rate: l.unitPrice,
                income_account: salesAcct,
            })),
            taxes: [
                {
                    charge_type: "Actual",
                    account_head: vatAcct,
                    tax_amount: -v.vatAmount,
                    description: "VAT 5%",
                },
            ],
            disable_rounded_total: 1,
            garageos_credit_note_id: v.originalInvoiceId,
            docstatus: 1,
        },
        opts,
    );

    const name = extractName(body, "Sales Invoice (credit note)");
    // Read-back: assert submitted + return-against link intact.
    const readBack = await frappeGet(
        creds,
        `/api/resource/Sales Invoice/${encodeURIComponent(name)}`,
        undefined,
        opts,
    );
    const docstatus = readBackField(readBack, "docstatus");
    if (docstatus !== 1) {
        throw new Error(
            `[erp-pusher] Credit note ${name}: docstatus=${docstatus}, expected 1`,
        );
    }
    const returnAgainst = readBackField(readBack, "return_against");
    if (returnAgainst !== v.originalErpnextName) {
        throw new Error(
            `[erp-pusher] Credit note ${name}: return_against=${returnAgainst}, expected ${v.originalErpnextName}`,
        );
    }
    const grandTotal = num(readBackField(readBack, "grand_total"));
    // Credit-note grand_total is negative in ERPNext.
    if (!eqCents(grandTotal, -v.total)) {
        throw new Error(
            `[erp-pusher] Credit note ${name}: grand_total=${grandTotal}, expected ${-v.total}`,
        );
    }
    return { erpnextName: name, preflightHit: false };
}

// ─────────────────────────────────────────────────────────────────
// Small helpers.

function ymd(d: Date): string {
    // ERPNext accepts YYYY-MM-DD posting dates. Use UTC to match
    // the Vercel deployment target (see AGENTS.md TZ notes).
    return d.toISOString().slice(0, 10);
}

function num(v: unknown): number {
    if (typeof v === "number") return v;
    if (typeof v === "string") return Number(v);
    return NaN;
}

function round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

function eqCents(a: number, b: number): boolean {
    return Math.abs(round2(a) - round2(b)) < 0.005;
}
