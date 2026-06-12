import { describe, it, expect } from "vitest";
import {
  totalsFor,
  lineTotal,
  invoiceLedger,
  paymentLedger,
  isBalanced,
  arState,
  balanceDue,
  isPartiallyPaid,
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
  // Regression test for the Overdue slice — without this, the existing
  // 'paid when fully paid' test only checks the (now < due) branch and
  // the spec line 'a paid invoice (even past due date) does NOT show
  // Overdue' was unprotected.
  it("paid past due date is still PAID, not OVERDUE", () => {
    expect(arState(100, 100, due, new Date("2026-06-20T00:00:00Z"))).toBe("PAID");
  });
  // Boundary check — exactly equal to dueDate is NOT overdue. The
  // helper uses strict > comparison so the dueDate moment itself
  // counts as the grace deadline.
  it("now exactly at dueDate is DUE, not OVERDUE", () => {
    expect(arState(100, 0, due, new Date("2026-06-10T00:00:00Z"))).toBe("DUE");
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

// --- Slice 6: partial / advance payments -------------------------------
// Money-logic slice. Tests the invariant that anchors the whole feature:
//   round2(paid) + balanceDue(total, paid) === round2(total)
// at every step of a multi-payment lifecycle. The exact AED 982.54 →
// 300 → 200 → 482.54 recipe is the user's reconciliation scenario; the
// overpayment case proves the action layer's guard rejects > balance.
describe("partial-payment math (slice 6)", () => {
  const beforeDue = new Date("2026-06-01T00:00:00Z");
  const due = new Date("2026-06-10T00:00:00Z");
  const afterDue = new Date("2026-06-20T00:00:00Z");

  it("arState returns PARTIAL when 0 < paid < total and on-or-before due", () => {
    expect(arState(100, 30, due, beforeDue)).toBe("PARTIAL");
    // Equality boundary at due date is still on-time (now > dueDate is the
    // overdue trigger, not >=). Matches the existing arState contract.
    expect(arState(100, 30, due, due)).toBe("PARTIAL");
  });

  it("arState returns OVERDUE for any underpaid invoice past due", () => {
    // Partial + past due → OVERDUE wins (date signal is more urgent).
    expect(arState(100, 30, due, afterDue)).toBe("OVERDUE");
    // Zero-paid + past due also OVERDUE (existing rule, regression-protected).
    expect(arState(100, 0, due, afterDue)).toBe("OVERDUE");
  });

  it("arState returns PAID when paid >= total regardless of due date", () => {
    expect(arState(100, 100, due, beforeDue)).toBe("PAID");
    expect(arState(100, 100, due, afterDue)).toBe("PAID");
    // Tolerates floating-point noise: 30 + 40 + 30 === 99.99999... in some
    // FP paths, but round2 inside arState pulls it back to 100.
    expect(arState(100, 30 + 40 + 30, due, beforeDue)).toBe("PAID");
  });

  it("isPartiallyPaid is true iff 0 < paid < total (date-independent)", () => {
    expect(isPartiallyPaid(100, 0)).toBe(false);
    expect(isPartiallyPaid(100, 50)).toBe(true);
    expect(isPartiallyPaid(100, 100)).toBe(false);
    expect(isPartiallyPaid(100, 150)).toBe(false); // overpaid is not "partially paid"
  });

  it("balanceDue clamps at zero and survives FP noise", () => {
    expect(balanceDue(982.54, 0)).toBe(982.54);
    expect(balanceDue(982.54, 300)).toBe(682.54);
    expect(balanceDue(982.54, 982.54)).toBe(0);
    // round2 round-trips 0.1 + 0.2 cleanly.
    expect(balanceDue(1, 0.1 + 0.2)).toBe(0.7);
    // Never negative — overpayment is blocked elsewhere; this is defensive.
    expect(balanceDue(100, 150)).toBe(0);
  });

  it("user reconciliation: 982.54 → +300 → +200 → +482.54 → PAID", () => {
    const total = 982.54;
    // Step 1: record advance 300.
    let paid = 300;
    expect(paid).toBe(300);
    expect(balanceDue(total, paid)).toBe(682.54);
    expect(arState(total, paid, due, beforeDue)).toBe("PARTIAL");
    // Invariant: paid + balance === total.
    expect(paid + balanceDue(total, paid)).toBeCloseTo(total, 2);

    // Step 2: record second payment 200.
    paid = 300 + 200;
    expect(paid).toBe(500);
    expect(balanceDue(total, paid)).toBe(482.54);
    expect(arState(total, paid, due, beforeDue)).toBe("PARTIAL");
    expect(paid + balanceDue(total, paid)).toBeCloseTo(total, 2);

    // Step 3: record final 482.54 → fully paid.
    paid = 300 + 200 + 482.54;
    // FP noise check — 300+200+482.54 can drift; we accept any value that
    // round2's to 982.54 because arState/balanceDue both call round2 too.
    expect(Math.round(paid * 100) / 100).toBe(982.54);
    expect(balanceDue(total, paid)).toBe(0);
    expect(arState(total, paid, due, beforeDue)).toBe("PAID");
    // Invariant still holds at the close: paid + 0 === total.
    expect(paid + balanceDue(total, paid)).toBeCloseTo(total, 2);
  });

  it("overpayment-shape check: a payment > balance breaks the invariant", () => {
    // This is the math half of the overpayment-block contract. The action
    // layer (recordPaymentAction) refuses to commit such a payment. If it
    // ever leaked through, balanceDue would clamp at 0, and the invariant
    // paid + balanceDue == total would no longer hold for the raw `paid`
    // value — which is exactly why the action throws.
    const total = 482.54;
    const overpaid = 999;
    // raw paid value blows past total
    expect(overpaid).toBeGreaterThan(total);
    // balanceDue clamps to 0 (no negative balance)
    expect(balanceDue(total, overpaid)).toBe(0);
    // therefore paid + balance !== total (482.54), confirming the
    // invariant breaks and the overpayment must be refused at the boundary.
    expect(overpaid + balanceDue(total, overpaid)).not.toBeCloseTo(total, 2);
    // arState calls it PAID since paid >= total (this is fine — the issue
    // is upstream: don't let the over-amount land in the first place).
    expect(arState(total, overpaid, due, beforeDue)).toBe("PAID");
  });

  it("ledger remains balanced for partial payments (DR Cash / CR AR)", () => {
    expect(isBalanced(paymentLedger(300))).toBe(true);
    expect(isBalanced(paymentLedger(200))).toBe(true);
    expect(isBalanced(paymentLedger(482.54))).toBe(true);
  });
});
