import { describe, it, expect } from "vitest";
import { classifyIntent } from "./copilot";

describe("copilot intent classification", () => {
  it("detects who-owes questions", () => {
    expect(classifyIntent("Who owes us money?")).toBe("WHO_OWES");
    expect(classifyIntent("show me outstanding invoices")).toBe("WHO_OWES");
  });
  it("detects profit questions", () => {
    expect(classifyIntent("How much profit this month?")).toBe("PROFIT_MONTH");
  });
  it("detects week-trend questions", () => {
    expect(classifyIntent("Are we up or down this week?")).toBe("WEEK_TREND");
  });
  // ── Slice #7 new intents ─────────────────────────────────────
  it("detects invoice-summary questions", () => {
    expect(classifyIntent("invoice summary")).toBe("INVOICES_SUMMARY");
    expect(classifyIntent("how many invoices this month?")).toBe(
      "INVOICES_SUMMARY",
    );
    expect(classifyIntent("invoice total")).toBe("INVOICES_SUMMARY");
    // ── Slice 'copilot natural phrasings' — AR's verify scenarios ──
    // 'invoices so far' previously fell through to UNKNOWN; this is
    // the regression guard for AR's reported case.
    expect(classifyIntent("invoices so far")).toBe("INVOICES_SUMMARY");
    expect(classifyIntent("invoices to date")).toBe("INVOICES_SUMMARY");
    expect(classifyIntent("invoices this year")).toBe("INVOICES_SUMMARY");
    expect(classifyIntent("invoices today")).toBe("INVOICES_SUMMARY");
    // Bare single-word query.
    expect(classifyIntent("invoices")).toBe("INVOICES_SUMMARY");
    expect(classifyIntent("invoice")).toBe("INVOICES_SUMMARY");
    expect(classifyIntent("invoices?")).toBe("INVOICES_SUMMARY");
    // Polite phrasing.
    expect(classifyIntent("any invoices?")).toBe("INVOICES_SUMMARY");
    expect(classifyIntent("show me invoices")).toBe("INVOICES_SUMMARY");
    expect(classifyIntent("show me all invoices")).toBe("INVOICES_SUMMARY");
  });
  it("detects VAT questions", () => {
    expect(classifyIntent("how much VAT this month?")).toBe("VAT_MONTH");
    expect(classifyIntent("tax collected this month")).toBe("VAT_MONTH");
  });
  it("detects outstanding-advance questions", () => {
    expect(classifyIntent("any unpaid advances?")).toBe(
      "ADVANCES_OUTSTANDING",
    );
    expect(classifyIntent("deposits not yet applied")).toBe(
      "ADVANCES_OUTSTANDING",
    );
  });
  it("detects top-technician questions", () => {
    expect(classifyIntent("who's the top technician?")).toBe("TECH_RANKING");
    expect(classifyIntent("best mechanic this week")).toBe("TECH_RANKING");
  });
  it("detects top-advisor questions", () => {
    expect(classifyIntent("best advisor by approval rate")).toBe(
      "ADVISOR_RANKING",
    );
    expect(classifyIntent("top service writer")).toBe("ADVISOR_RANKING");
  });
  it("detects ledger-balance questions", () => {
    expect(classifyIntent("cash and AR balance")).toBe("LEDGER_BALANCE");
    expect(classifyIntent("what's our cash position?")).toBe("LEDGER_BALANCE");
  });
  it("returns UNKNOWN for unsupported questions", () => {
    expect(classifyIntent("what is the meaning of life")).toBe("UNKNOWN");
  });
  it("'invoice' alone in a who-owes question still routes correctly", () => {
    // Regression: 'show me outstanding invoices' must remain WHO_OWES,
    // not get hijacked by the new INVOICES_SUMMARY pattern.
    expect(classifyIntent("show me outstanding invoices")).toBe("WHO_OWES");
  });
});
