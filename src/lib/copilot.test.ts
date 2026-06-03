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
  it("returns UNKNOWN for unsupported questions", () => {
    expect(classifyIntent("what is the meaning of life")).toBe("UNKNOWN");
  });
});
