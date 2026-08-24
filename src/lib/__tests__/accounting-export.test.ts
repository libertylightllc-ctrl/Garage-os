import { describe, it, expect } from "vitest";
import {
    chartOfAccountsCsv,
    journalCsv,
    invoicesCsv,
    paymentsCsv,
    customersCsv,
    filename,
    COA,
    type JournalRow,
    type InvoiceRow,
    type PaymentRow,
    type CustomerRow,
} from "@/lib/accounting-export";

// All rows serialised with CRLF per RFC 4180. Tests assert on the
// exact wire shape — if a header order changes, an accountant's
// column mappings in QuickBooks/Xero break silently, so pin them.

describe("chartOfAccountsCsv", () => {
    it("has exactly six accounts — five in-DB + two synthetic cash split (Cash/Bank contributes both)", () => {
        // Sanity: our COA table is the source of truth for what the
        // export ships. Any drift in the account SET (not the code
        // numbers, which are a convention) needs a deliberate change
        // to both the export AND the mapping doc.
        expect(COA).toHaveLength(6);
        const names = COA.map((r) => r.name).sort();
        expect(names).toEqual([
            "Accounts Receivable",
            "Bank / Card POS",
            "Cash on Hand",
            "Customer Deposits",
            "Sales Revenue",
            "VAT Payable",
        ]);
    });

    it("emits the RFC 4180 header and one row per account", () => {
        const csv = chartOfAccountsCsv();
        const lines = csv.split("\r\n").filter(Boolean);
        expect(lines[0]).toBe("code,name,type,normal_balance,currency,notes");
        expect(lines.length).toBe(1 + COA.length);
    });

    it("marks the two Cash/Bank-derived accounts with a notes entry so the mapping is discoverable in the CSV itself", () => {
        const csv = chartOfAccountsCsv();
        expect(csv).toContain('1000,Cash on Hand,Asset,DR,AED,Cash/Bank (Payment.method=CASH)');
        expect(csv).toContain('1010,Bank / Card POS,Asset,DR,AED,Cash/Bank (Payment.method=CARD)');
    });

    it("non-derived accounts have an empty notes cell (no phantom mapping)", () => {
        const csv = chartOfAccountsCsv();
        expect(csv).toContain("1100,Accounts Receivable,Asset,DR,AED,\r\n");
    });
});

describe("journalCsv — account code resolution", () => {
    const baseRow: Omit<JournalRow, "account" | "sourceType" | "paymentMethod"> = {
        createdAt: new Date("2026-08-15T10:00:00Z"),
        debit: 100,
        credit: 0,
        sourceId: "ledger-1",
        invoiceNumber: 42,
        customerName: "Ahmed Al Mansoori",
    };

    it("routes each in-DB account name to its code (non-cash accounts)", () => {
        const rows: JournalRow[] = [
            { ...baseRow, account: "Accounts Receivable", sourceType: "INVOICE" },
            { ...baseRow, account: "Sales Revenue", sourceType: "INVOICE" },
            { ...baseRow, account: "VAT Payable", sourceType: "INVOICE" },
            { ...baseRow, account: "Customer Deposits", sourceType: "ADVANCE" },
        ];
        const csv = journalCsv(rows);
        expect(csv).toContain(",1100,Accounts Receivable,");
        expect(csv).toContain(",4000,Sales Revenue,");
        expect(csv).toContain(",2100,VAT Payable,");
        expect(csv).toContain(",2200,Customer Deposits,");
    });

    it("splits Cash/Bank by resolved payment method — CASH → 1000", () => {
        const csv = journalCsv([
            { ...baseRow, account: "Cash/Bank", sourceType: "PAYMENT", paymentMethod: "CASH" },
        ]);
        expect(csv).toContain(",1000,Cash/Bank,");
        expect(csv).not.toContain(",1010,");
    });

    it("splits Cash/Bank by resolved payment method — CARD → 1010", () => {
        const csv = journalCsv([
            { ...baseRow, account: "Cash/Bank", sourceType: "PAYMENT", paymentMethod: "CARD" },
        ]);
        expect(csv).toContain(",1010,Cash/Bank,");
        expect(csv).not.toContain(",1000,");
    });

    it("defaults Cash/Bank to 1000 when method is null (advance-migration DR-Deposits/CR-AR has no cash side, but any orphan cash row is safer under Cash on Hand)", () => {
        const csv = journalCsv([
            { ...baseRow, account: "Cash/Bank", sourceType: "PAYMENT", paymentMethod: null },
        ]);
        expect(csv).toContain(",1000,Cash/Bank,");
    });

    it("formats journal_ref with the invoice number when available; falls back to sourceType:sourceId otherwise", () => {
        const withInvoice = journalCsv([
            { ...baseRow, account: "Sales Revenue", sourceType: "INVOICE", invoiceNumber: 42 },
        ]);
        expect(withInvoice).toContain(",INV-42,");
        const withoutInvoice = journalCsv([
            { ...baseRow, account: "Cash/Bank", sourceType: "PAYMENT", invoiceNumber: null, sourceId: "pay-99" },
        ]);
        expect(withoutInvoice).toContain(",PAYMENT:pay-99,");
    });

    it("emits amounts with 2dp always — never 100 or 100.5", () => {
        const csv = journalCsv([
            { ...baseRow, account: "Sales Revenue", sourceType: "INVOICE", debit: 100, credit: 0 },
            { ...baseRow, account: "Sales Revenue", sourceType: "INVOICE", debit: 100.5, credit: 0 },
        ]);
        expect(csv).toContain(",100.00,0.00,");
        expect(csv).toContain(",100.50,0.00,");
    });
});

describe("invoicesCsv", () => {
    it("headers pin the exact column order accountants map against", () => {
        const csv = invoicesCsv([]);
        const [header] = csv.split("\r\n");
        expect(header).toBe(
            "invoice_number,issued_at,due_date,customer_name,customer_trn,subtotal,vat,total,status,paid,balance,currency",
        );
    });

    it("emits INV-N formatted number + ISO date + 2dp amounts + empty due_date when null", () => {
        const rows: InvoiceRow[] = [{
            number: 17,
            issuedAt: new Date("2026-08-01T08:00:00Z"),
            dueDate: null,
            customerName: "GULF, & \"CO\" LLC",
            customerTrn: "100000000000003",
            subtotal: 300, vatAmount: 15, total: 315,
            status: "PAID", paid: 315, balance: 0,
        }];
        const csv = invoicesCsv(rows);
        // Comma + double-quote inside name → RFC 4180-quoted with doubled quotes.
        expect(csv).toContain(`INV-17,2026-08-01,,"GULF, & ""CO"" LLC",100000000000003,300.00,15.00,315.00,PAID,315.00,0.00,AED`);
    });
});

describe("paymentsCsv", () => {
    it("headers include kind first so PAYMENT vs ADVANCE is the primary sort dimension for an accountant reading top-down", () => {
        const csv = paymentsCsv([]);
        expect(csv.split("\r\n")[0]).toBe(
            "kind,date,method,amount,invoice_number,job_number,customer_name,migrated_to_invoice,currency",
        );
    });

    it("Payment row: invoice_number filled, job_number empty, no migration link", () => {
        const rows: PaymentRow[] = [{
            kind: "PAYMENT",
            date: new Date("2026-08-15T12:00:00Z"),
            method: "CASH",
            amount: 210,
            invoiceNumber: 42,
            customerName: "Ahmed",
        }];
        const csv = paymentsCsv(rows);
        expect(csv).toContain("PAYMENT,2026-08-15,CASH,210.00,INV-42,,Ahmed,,AED");
    });

    it("AdvancePayment row: job_number filled, invoice_number empty, migrated_to_invoice populated once migrated", () => {
        const rows: PaymentRow[] = [{
            kind: "ADVANCE",
            date: new Date("2026-08-10T09:00:00Z"),
            method: "CARD",
            amount: 100,
            jobNumber: 55,
            migratedToInvoiceNumber: 43,
            customerName: "Fatima",
        }];
        const csv = paymentsCsv(rows);
        expect(csv).toContain("ADVANCE,2026-08-10,CARD,100.00,,JC-55,Fatima,INV-43,AED");
    });
});

describe("customersCsv", () => {
    it("headers stop at the invoice count — no fields beyond what the accountant needs to reconcile", () => {
        expect(customersCsv([]).split("\r\n")[0]).toBe(
            "customer_id,name,phone,email,trn,invoices_in_range",
        );
    });

    it("handles missing email/trn as empty cells, not the word null", () => {
        const rows: CustomerRow[] = [{
            id: "c1", name: "Walk-in", phone: "971501234567",
            email: null, trn: null, invoicesInRange: 2,
        }];
        expect(customersCsv(rows)).toContain("c1,Walk-in,971501234567,,,2");
    });
});

describe("filename", () => {
    it("names the file with the exported range so it's self-describing", () => {
        expect(filename("journal", new Date("2026-08-01T00:00:00Z"), new Date("2026-08-31T23:59:59Z")))
            .toBe("accounting-journal-2026-08-01_2026-08-31.csv");
    });
});
