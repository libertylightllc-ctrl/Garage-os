import { describe, it, expect } from "vitest";
import {
  totalsFor,
  lineTotal,
  invoiceLedger,
  paymentLedger,
  isBalanced,
  arState,
  formatInvoiceNo,
  isRecordableMethod,
  type DraftLine,
} from "./billing";

const lines: DraftLine[] = [
  { kind: "LABOR", description: "Diagnostics", qty: 1, unitPrice: 150 },
  { kind: "PART", description: "Air filter", qty: 2, unitPrice: 60 },
];

describe("billing totals", () => {
  it("computes line totals and 5% VAT", () => {
    expect(lineTotal(2, 60)).toBe(120);
    const t = totalsFor(lines); // subtotal 270
    expect(t).toEqual({ subtotal: 270, vatAmount: 13.5, total: 283.5 });
  });
});

describe("zero-entry ledger", () => {
  it("invoice entries balance (debits == credits)", () => {
    const t = totalsFor(lines);
    const rows = invoiceLedger(t.subtotal, t.vatAmount, t.total);
    expect(isBalanced(rows)).toBe(true);
    expect(rows.find((r) => r.account === "Accounts Receivable")?.debit).toBe(283.5);
  });

  it("payment entries balance", () => {
    expect(isBalanced(paymentLedger(283.5))).toBe(true);
  });
});

describe("AR status", () => {
  const due = new Date("2026-06-10T00:00:00Z");
  it("paid when fully paid", () => {
    expect(arState(100, 100, due, new Date("2026-06-01T00:00:00Z"))).toBe("PAID");
  });
  it("due when unpaid and before due date", () => {
    expect(arState(100, 0, due, new Date("2026-06-01T00:00:00Z"))).toBe("DUE");
  });
  it("overdue when unpaid and past due date", () => {
    expect(arState(100, 40, due, new Date("2026-06-20T00:00:00Z"))).toBe("OVERDUE");
  });
});

describe("payment methods", () => {
  it("records Cash and Card (POS) immediately", () => {
    expect(isRecordableMethod("CASH")).toBe(true);
    expect(isRecordableMethod("CARD_POS")).toBe(true);
  });
  it("treats Online Link as a stub (not yet recordable)", () => {
    expect(isRecordableMethod("ONLINE_LINK")).toBe(false);
    expect(isRecordableMethod("anything")).toBe(false);
  });
});

describe("invoice number formatting", () => {
  it("zero-pads per-year sequence", () => {
    expect(formatInvoiceNo(1, 2026)).toBe("INV-2026-0001");
    expect(formatInvoiceNo(42, 2026)).toBe("INV-2026-0042");
  });
});
