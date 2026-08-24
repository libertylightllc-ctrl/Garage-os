/**
 * Accounting export — pure CSV builders (AR 2026-08-23).
 *
 * Contract: functions here take rows-in-memory and return CSV strings.
 * No DB access, no I/O — the /api/accounting/export route does the
 * reads and hands rows to these functions. That split keeps CSV shape
 * testable without a database and keeps the route thin.
 *
 * Five files, all owner-scoped by the caller BEFORE calling in:
 *   1. chart-of-accounts.csv — one-time COA setup for the target system
 *   2. journal.csv          — one row per LedgerEntry
 *   3. invoices.csv         — invoice list in the date range
 *   4. payments.csv         — Payment + AdvancePayment unioned in the range
 *   5. customers.csv        — ONLY customers that appear in the range's
 *                             invoices (see route.ts scoping). Not the
 *                             full customer list — reduces PII leaving
 *                             the system to what the accountant actually
 *                             needs to reconcile the invoices.
 *
 * Cash/Bank contract (AR 2026-08-23): the LedgerEntry table stores a
 * single "Cash/Bank" account. The export DERIVES the split at wire time
 * from the resolved Payment.method — CASH → account code 1000 "Cash on
 * Hand", CARD → 1010 "Bank / Card POS". This is a mapping-only feature;
 * the ledger schema and existing writers are unchanged. Limitation
 * documented in docs/accounting-chart-of-accounts.md.
 *
 * Account codes: chosen conventional UAE-SME numbers, documented in
 * the companion .md. If an accountant's target COA uses different
 * codes, they remap once on import — the NAMES are stable and match
 * the on-screen ledger.
 */

import type { Decimal } from "@/generated/prisma/internal/prismaNamespace";

// ── Chart of accounts ────────────────────────────────────────────────
// Mapping from the 5 in-DB account strings (defined in src/lib/billing.ts
// ACCOUNTS) to a code + type + normal balance. The bank/cash split is
// synthetic — see the mapping doc.

export type NormalBalance = "DR" | "CR";
export type AccountType = "Asset" | "Liability" | "Revenue" | "Equity" | "Expense";

export interface CoaRow {
    code: string;
    name: string;
    type: AccountType;
    normal: NormalBalance;
    currency: "AED";
    /** Present on the two synthetic bank/cash accounts. */
    derivedFrom?: string;
}

export const COA: CoaRow[] = [
    // Assets — debit-normal.
    { code: "1000", name: "Cash on Hand",       type: "Asset",     normal: "DR", currency: "AED", derivedFrom: "Cash/Bank (Payment.method=CASH)" },
    { code: "1010", name: "Bank / Card POS",    type: "Asset",     normal: "DR", currency: "AED", derivedFrom: "Cash/Bank (Payment.method=CARD)" },
    { code: "1100", name: "Accounts Receivable", type: "Asset",    normal: "DR", currency: "AED" },
    // Liabilities — credit-normal.
    { code: "2100", name: "VAT Payable",         type: "Liability", normal: "CR", currency: "AED" },
    { code: "2200", name: "Customer Deposits",   type: "Liability", normal: "CR", currency: "AED" },
    // Revenue — credit-normal.
    { code: "4000", name: "Sales Revenue",       type: "Revenue",   normal: "CR", currency: "AED" },
];

/**
 * Ledger account-name → account-code lookup for the general journal.
 * The five in-DB names route to codes; "Cash/Bank" splits at export
 * time via `resolveCashAccount()` below because the ledger doesn't
 * store the payment method on the row itself.
 */
const NAME_TO_CODE: Record<string, string> = {
    "Accounts Receivable": "1100",
    "VAT Payable": "2100",
    "Customer Deposits": "2200",
    "Sales Revenue": "4000",
    // "Cash/Bank" intentionally omitted — resolved via sourceType +
    // resolved payment method by resolveAccountCode below.
};

// ── CSV plumbing ─────────────────────────────────────────────────────
// RFC 4180: fields containing comma, double-quote, or CR/LF must be
// wrapped in double-quotes, and any embedded double-quote is doubled.
// Everything else passes through verbatim.
function csvEscape(v: string | number | null | undefined): string {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function csvLine(cells: (string | number | null | undefined)[]): string {
    return cells.map(csvEscape).join(",");
}

function csvOf(header: string[], rows: (string | number | null | undefined)[][]): string {
    return [csvLine(header), ...rows.map(csvLine)].join("\r\n") + "\r\n";
}

function toMoney(d: Decimal | number | string): string {
    const n = typeof d === "number" ? d : Number(d);
    return n.toFixed(2);
}

function toIsoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

// ── 1. Chart of Accounts ─────────────────────────────────────────────
export function chartOfAccountsCsv(): string {
    return csvOf(
        ["code", "name", "type", "normal_balance", "currency", "notes"],
        COA.map((r) => [
            r.code,
            r.name,
            r.type,
            r.normal,
            r.currency,
            r.derivedFrom ?? "",
        ]),
    );
}

// ── 2. Journal ───────────────────────────────────────────────────────
// One row per LedgerEntry. account_code resolved via NAME_TO_CODE +
// (for "Cash/Bank" only) via resolveCashAccount using the paymentMethod
// carried on the joined row.

export interface JournalRow {
    createdAt: Date;
    account: string;                 // raw ACCOUNTS.* value from LedgerEntry.account
    debit: Decimal | number;
    credit: Decimal | number;
    sourceType: string;              // INVOICE | INVOICE_VOID | PAYMENT | ADVANCE | ADVANCE_MIGRATION
    sourceId: string;
    // Resolved fields — populated by the caller via joins. Nullable
    // because not every sourceType resolves cleanly (a deleted invoice
    // that only has audit rows won't join).
    invoiceNumber?: number | null;   // formatted at output time
    customerName?: string | null;
    /** Only meaningful when the ledger row's account is "Cash/Bank". */
    paymentMethod?: "CASH" | "CARD" | null;
}

/**
 * "Cash/Bank" bank-vs-cash split. Rules:
 *  - Payment.method === "CASH"  → 1000 Cash on Hand
 *  - Payment.method === "CARD"  → 1010 Bank / Card POS
 *  - Missing / unknown / advance-migration-DR (which doesn't touch
 *    cash) → default to 1000 with a note. The default matters more
 *    than perfect fidelity here — an unmatched Cash/Bank row still
 *    reconciles at the aggregate level.
 */
function resolveCashAccount(method: "CASH" | "CARD" | null | undefined): string {
    if (method === "CARD") return "1010";
    return "1000";
}

function resolveAccountCode(row: JournalRow): string {
    if (row.account === "Cash/Bank") return resolveCashAccount(row.paymentMethod);
    return NAME_TO_CODE[row.account] ?? "";
}

export function journalCsv(rows: JournalRow[]): string {
    return csvOf(
        ["date", "journal_ref", "account_code", "account_name", "debit", "credit", "currency", "customer", "memo"],
        rows.map((r) => {
            const ref = r.invoiceNumber != null
                ? `INV-${r.invoiceNumber}`
                : `${r.sourceType}:${r.sourceId}`;
            const memo = `${r.sourceType} ${r.sourceId}`;
            return [
                toIsoDate(r.createdAt),
                ref,
                resolveAccountCode(r),
                r.account,
                toMoney(r.debit),
                toMoney(r.credit),
                "AED",
                r.customerName ?? "",
                memo,
            ];
        }),
    );
}

// ── 3. Invoices ──────────────────────────────────────────────────────

export interface InvoiceRow {
    number: number;
    issuedAt: Date;
    dueDate: Date | null;
    customerName: string;
    customerTrn: string | null;
    subtotal: Decimal | number;
    vatAmount: Decimal | number;
    total: Decimal | number;
    status: string;
    paid: Decimal | number;
    balance: Decimal | number;
}

export function invoicesCsv(rows: InvoiceRow[]): string {
    return csvOf(
        ["invoice_number", "issued_at", "due_date", "customer_name", "customer_trn", "subtotal", "vat", "total", "status", "paid", "balance", "currency"],
        rows.map((r) => [
            `INV-${r.number}`,
            toIsoDate(r.issuedAt),
            r.dueDate ? toIsoDate(r.dueDate) : "",
            r.customerName,
            r.customerTrn ?? "",
            toMoney(r.subtotal),
            toMoney(r.vatAmount),
            toMoney(r.total),
            r.status,
            toMoney(r.paid),
            toMoney(r.balance),
            "AED",
        ]),
    );
}

// ── 4. Payments ──────────────────────────────────────────────────────
// Union of Payment (against a specific invoice) and AdvancePayment
// (received before an invoice exists, later migrated). Kind column
// distinguishes them.

export interface PaymentRow {
    kind: "PAYMENT" | "ADVANCE";
    date: Date;                                // paidAt (Payment) or receivedAt (AdvancePayment)
    method: "CASH" | "CARD" | string;
    amount: Decimal | number;
    // Only one of these is populated per row. Payment → invoiceNumber.
    // AdvancePayment → jobNumber (the job the advance was against).
    invoiceNumber?: number | null;
    jobNumber?: number | null;
    customerName: string;
    /** For AdvancePayment: set to the invoice number the advance was
     *  later migrated onto, if any; null while still open. */
    migratedToInvoiceNumber?: number | null;
}

export function paymentsCsv(rows: PaymentRow[]): string {
    return csvOf(
        ["kind", "date", "method", "amount", "invoice_number", "job_number", "customer_name", "migrated_to_invoice", "currency"],
        rows.map((r) => [
            r.kind,
            toIsoDate(r.date),
            r.method,
            toMoney(r.amount),
            r.invoiceNumber != null ? `INV-${r.invoiceNumber}` : "",
            r.jobNumber != null ? `JC-${r.jobNumber}` : "",
            r.customerName,
            r.migratedToInvoiceNumber != null ? `INV-${r.migratedToInvoiceNumber}` : "",
            "AED",
        ]),
    );
}

// ── 5. Customers (range-scoped) ──────────────────────────────────────
// Only customers who appear in the date-range's invoices. Excluding
// walk-ins with no invoices in the period keeps PII leaving the app
// tight to what the accountant needs to reconcile.

export interface CustomerRow {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    trn: string | null;
    /** Number of invoices from this customer in the exported range. */
    invoicesInRange: number;
}

export function customersCsv(rows: CustomerRow[]): string {
    return csvOf(
        ["customer_id", "name", "phone", "email", "trn", "invoices_in_range"],
        rows.map((r) => [
            r.id,
            r.name,
            r.phone,
            r.email ?? "",
            r.trn ?? "",
            r.invoicesInRange,
        ]),
    );
}

// ── Range formatting for filenames ───────────────────────────────────
// "accounting-journal-2026-08-01_2026-08-31.csv" — self-describing so
// an accountant knows what's in the file without opening it.
export function filename(file: string, from: Date, to: Date): string {
    return `accounting-${file}-${toIsoDate(from)}_${toIsoDate(to)}.csv`;
}
