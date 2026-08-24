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
        invoiceIssuedAt: new Date("2026-08-15T10:00:00Z"),
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

    it("formats journal_ref as INV-YYYY-#### (canonical) — matches every display surface, not the raw INV-N", () => {
        // AR 2026-08-25 verify #2: was rendering "INV-42" which
        // disagreed with the 11 UI surfaces that all use
        // formatInvoiceNo → "INV-2026-0042". Year comes from the
        // invoice's issuedAt, not the ledger row's createdAt (they
        // may differ for cross-year payments/migrations).
        const withInvoice = journalCsv([
            { ...baseRow, account: "Sales Revenue", sourceType: "INVOICE",
              invoiceNumber: 42, invoiceIssuedAt: new Date("2026-08-15T10:00:00Z") },
        ]);
        expect(withInvoice).toContain(",INV-2026-0042,");
        expect(withInvoice).not.toContain(",INV-42,");
        const withoutInvoice = journalCsv([
            { ...baseRow, account: "Cash/Bank", sourceType: "PAYMENT",
              invoiceNumber: null, invoiceIssuedAt: null, sourceId: "pay-99" },
        ]);
        expect(withoutInvoice).toContain(",PAYMENT:pay-99,");
    });

    it("uses the INVOICE's year for the ref, not the ledger row's year — payment in 2027 for a 2026 invoice", () => {
        // Cross-year payment: ledger createdAt = 2027 (when the
        // payment was recorded); invoice issuedAt = 2026. The
        // journal_ref must carry the invoice's year (2026), not
        // the ledger's (2027), or the accountant can't reconcile.
        const csv = journalCsv([{
            ...baseRow,
            account: "Cash/Bank", sourceType: "PAYMENT",
            createdAt: new Date("2027-01-15T10:00:00Z"),
            invoiceNumber: 53, invoiceIssuedAt: new Date("2026-12-22T10:00:00Z"),
            paymentMethod: "CASH",
        }]);
        expect(csv).toContain(",INV-2026-0053,");
        expect(csv).not.toContain(",INV-2027-0053,");
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

    it("emits INV-YYYY-#### canonical number + ISO date in Dubai time + 2dp amounts + empty due_date when null", () => {
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
        // Was `INV-17,…` pre-2026-08-25 fix (missing year). Now matches
        // every display surface via formatInvoiceNo.
        expect(csv).toContain(`INV-2026-0017,2026-08-01,,"GULF, & ""CO"" LLC",100000000000003,300.00,15.00,315.00,PAID,315.00,0.00,AED`);
    });

    it("renders the DATE in Dubai time — the month-boundary case where UTC and Dubai disagree", () => {
        // AR 2026-08-25 verify #2: an invoice issued at 22:00 Dubai
        // on Aug 31 (= 18:00 UTC same day) is Aug 31 in both zones.
        // The failing shape is an invoice issued at 02:00 Dubai on
        // Sep 1 (= 22:00 Aug 31 UTC). Previously rendered `2026-08-31`
        // (UTC month) even though the customer's copy of the invoice
        // reads Sep 1. Now: renders `2026-09-01`, matching Dubai.
        const rows: InvoiceRow[] = [{
            number: 54,
            // 22:00 Aug 31 UTC = 02:00 Sep 1 Dubai
            issuedAt: new Date("2026-08-31T22:00:00Z"),
            dueDate: new Date("2026-09-30T00:00:00Z"),
            customerName: "Acme",
            customerTrn: null,
            subtotal: 100, vatAmount: 5, total: 105,
            status: "SENT", paid: 0, balance: 105,
        }];
        const csv = invoicesCsv(rows);
        expect(csv).toContain("INV-2026-0054,2026-09-01,");
        expect(csv).not.toContain(",2026-08-31,");
    });
});

describe("paymentsCsv", () => {
    it("headers include kind first so PAYMENT vs ADVANCE is the primary sort dimension for an accountant reading top-down", () => {
        const csv = paymentsCsv([]);
        expect(csv.split("\r\n")[0]).toBe(
            "kind,date,method,amount,invoice_number,job_number,customer_name,migrated_to_invoice,currency",
        );
    });

    it("Payment row: canonical INV-YYYY-#### number, job_number empty, no migration link", () => {
        const rows: PaymentRow[] = [{
            kind: "PAYMENT",
            date: new Date("2026-08-15T12:00:00Z"),
            method: "CASH",
            amount: 210,
            invoiceNumber: 42,
            invoiceIssuedAt: new Date("2026-08-15T12:00:00Z"),
            customerName: "Ahmed",
        }];
        const csv = paymentsCsv(rows);
        expect(csv).toContain("PAYMENT,2026-08-15,CASH,210.00,INV-2026-0042,,Ahmed,,AED");
    });

    it("AdvancePayment row: migrated_to_invoice uses canonical INV-YYYY-#### shape too", () => {
        const rows: PaymentRow[] = [{
            kind: "ADVANCE",
            date: new Date("2026-08-10T09:00:00Z"),
            method: "CARD",
            amount: 100,
            jobNumber: 55,
            migratedToInvoiceNumber: 43,
            migratedToInvoiceIssuedAt: new Date("2026-08-11T09:00:00Z"),
            customerName: "Fatima",
        }];
        const csv = paymentsCsv(rows);
        expect(csv).toContain("ADVANCE,2026-08-10,CARD,100.00,,JC-55,Fatima,INV-2026-0043,AED");
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
    it("names the file with the exported range so it's self-describing, rendered in Dubai time", () => {
        // AR 2026-08-25 verify #2: filename renders through the same
        // Dubai timezone as every date cell. Both fixtures below are
        // WITHIN Aug 2026 in Dubai (04:00 Aug 1 UTC = 08:00 Aug 1
        // Dubai; 18:00 Aug 31 UTC = 22:00 Aug 31 Dubai) so the
        // filename reads "…2026-08-01_2026-08-31.csv" as expected.
        expect(filename("journal", new Date("2026-08-01T04:00:00Z"), new Date("2026-08-31T18:00:00Z")))
            .toBe("accounting-journal-2026-08-01_2026-08-31.csv");
    });

    it("filename also renders in Dubai — a 'to' date at 22:00 UTC on Aug 31 (= 02:00 Sep 1 Dubai) reads 2026-09-01, not 2026-08-31", () => {
        // Same class of month-boundary drift as the invoice-row date
        // rendering. Pins the filename side of that contract.
        expect(filename("journal", new Date("2026-08-01T04:00:00Z"), new Date("2026-08-31T22:00:00Z")))
            .toBe("accounting-journal-2026-08-01_2026-09-01.csv");
    });
});
