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
  isQuoteIncrease,
  jobPartLineDescription,
  parseLineEditInput,
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

describe("jobPartLineDescription", () => {
  it("prefixes the part No when present", () => {
    expect(jobPartLineDescription("BRK-PAD-F", "Front brake pads")).toBe("BRK-PAD-F — Front brake pads");
  });
  it("falls back to just the description", () => {
    expect(jobPartLineDescription(null, "Ignition coil")).toBe("Ignition coil");
    expect(jobPartLineDescription("  ", "Ignition coil")).toBe("Ignition coil");
    expect(jobPartLineDescription(undefined, "Ignition coil")).toBe("Ignition coil");
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
  it("only records cash/card — the app never processes online payments", () => {
    expect(isRecordableMethod("ONLINE_LINK")).toBe(false);
    expect(isRecordableMethod("anything")).toBe(false);
  });
});

describe("isQuoteIncrease (extra-work re-approval)", () => {
  it("flags a higher revised quote", () => {
    expect(isQuoteIncrease(500, 300)).toBe(true);
  });
  it("does not flag the first quote (no prior approval)", () => {
    expect(isQuoteIncrease(300, 0)).toBe(false);
  });
  it("does not flag same-or-lower totals", () => {
    expect(isQuoteIncrease(300, 300)).toBe(false);
    expect(isQuoteIncrease(250, 300)).toBe(false);
  });
});

describe("invoice number formatting", () => {
  it("zero-pads per-year sequence", () => {
    expect(formatInvoiceNo(1, 2026)).toBe("INV-2026-0001");
    expect(formatInvoiceNo(42, 2026)).toBe("INV-2026-0042");
  });
});

describe("parseLineEditInput — validation + DISCOUNT sign convention", () => {
  const good = { kind: "LABOR", description: "Diagnostics", qty: "1", unitPrice: "150" };

  it("happy path — labor line, positive price", () => {
    const r = parseLineEditInput(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r).toMatchObject({
        kind: "LABOR",
        description: "Diagnostics",
        qty: 1,
        unitPrice: 150,
      });
    }
  });

  it("trims description whitespace", () => {
    const r = parseLineEditInput({ ...good, description: "  AC service  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.description).toBe("AC service");
  });

  it("DISCOUNT stores as FEE with a NEGATIVE price (sign sugar)", () => {
    const r = parseLineEditInput({ kind: "DISCOUNT", description: "Goodwill", qty: 1, unitPrice: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("FEE");
      expect(r.unitPrice).toBe(-50);
    }
  });

  it("DISCOUNT discards a user-entered minus — uses abs() then re-signs", () => {
    // If the form input said -50, we still treat the magnitude as 50 and
    // apply the negative ourselves. Stops a misclick double-negative.
    const r = parseLineEditInput({ kind: "DISCOUNT", description: "x", qty: 1, unitPrice: -50 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unitPrice).toBe(-50);
  });

  it("kind is case-insensitive (form sends 'labor', server stores 'LABOR')", () => {
    const r = parseLineEditInput({ ...good, kind: "part" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("PART");
  });

  it("rejects empty / whitespace-only description", () => {
    expect(parseLineEditInput({ ...good, description: "" })).toEqual({
      ok: false,
      error: "missing-description",
    });
    expect(parseLineEditInput({ ...good, description: "   " })).toEqual({
      ok: false,
      error: "missing-description",
    });
  });

  it("rejects unknown kind", () => {
    expect(parseLineEditInput({ ...good, kind: "TAX" })).toEqual({
      ok: false,
      error: "unknown-kind",
    });
    expect(parseLineEditInput({ ...good, kind: "" })).toEqual({
      ok: false,
      error: "unknown-kind",
    });
  });

  it("rejects qty ≤ 0, non-numeric qty, infinite qty", () => {
    expect(parseLineEditInput({ ...good, qty: "0" }).ok).toBe(false);
    expect(parseLineEditInput({ ...good, qty: "-1" }).ok).toBe(false);
    expect(parseLineEditInput({ ...good, qty: "abc" }).ok).toBe(false);
    expect(parseLineEditInput({ ...good, qty: Infinity }).ok).toBe(false);
  });

  it("rejects negative price for non-DISCOUNT lines", () => {
    // For LABOR/PART/FEE, a negative price is a data error — DISCOUNT is
    // the only valid way to encode a sign flip.
    expect(parseLineEditInput({ ...good, unitPrice: "-10" }).ok).toBe(false);
  });

  it("rejects NaN price", () => {
    expect(parseLineEditInput({ ...good, unitPrice: "not-a-number" }).ok).toBe(false);
  });

  it("zero price is allowed (free labor, comp'd item)", () => {
    const r = parseLineEditInput({ ...good, unitPrice: "0" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unitPrice).toBe(0);
  });

  it("fractional qty is allowed (0.5 hours of labor)", () => {
    const r = parseLineEditInput({ ...good, qty: "0.5" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.qty).toBe(0.5);
  });
});
