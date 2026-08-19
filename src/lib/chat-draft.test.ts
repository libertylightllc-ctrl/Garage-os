import { describe, it, expect } from "vitest";
import { hasUnfilledPlaceholders, DRAFT_MARKERS } from "./chat-draft";

// AR 2026-08-19 — pins the exit-gate for approveDraftAction. On
// 2026-08-18 an advisor clicked Approve on an unedited draft and the
// customer received "[مسودة] إجمالي السعر التقديري هو ___ درهم شامل
// الضريبة. هل تريد المتابعة؟" — literal marker + `___` placeholder.
// Business rule 4 (WhatsApp hand-off is not delivery) makes wa.me
// mis-messages unretractable. Every marker + the `___` pattern is
// pinned here.
describe("hasUnfilledPlaceholders", () => {
  it("clean edited draft passes", () => {
    expect(
      hasUnfilledPlaceholders(
        "The estimated total is AED 275.00 incl. VAT. Shall we proceed?",
      ),
    ).toBe(false);
    expect(
      hasUnfilledPlaceholders(
        "إجمالي السعر التقديري هو 275.00 درهم شامل الضريبة. هل تريد المتابعة؟",
      ),
    ).toBe(false);
  });

  it("catches the literal ___ placeholder", () => {
    expect(hasUnfilledPlaceholders("Total is AED ___ incl. VAT.")).toBe(true);
  });

  it("catches long placeholders (____, _____) — future draft variants", () => {
    expect(hasUnfilledPlaceholders("Ready by ____.")).toBe(true);
    expect(hasUnfilledPlaceholders("Diagnosis: _______.")).toBe(true);
  });

  it("but not one or two underscores — those are legit prose", () => {
    // A path like foo_bar or a word_wrap is not a placeholder.
    expect(hasUnfilledPlaceholders("Cost is 45 AED for foo_bar and __ok__ tests.")).toBe(false);
  });

  it("catches the English [draft] marker case-insensitively", () => {
    expect(hasUnfilledPlaceholders("[draft] Total is AED 275.")).toBe(true);
    expect(hasUnfilledPlaceholders("[Draft] Total is AED 275.")).toBe(true);
    expect(hasUnfilledPlaceholders("[DRAFT] Total is AED 275.")).toBe(true);
  });

  it("catches the Arabic [مسودة] marker", () => {
    expect(
      hasUnfilledPlaceholders("[مسودة] إجمالي السعر التقديري هو 275 درهم."),
    ).toBe(true);
  });

  it("catches the Hindi [ड्राफ्ट] marker", () => {
    expect(hasUnfilledPlaceholders("[ड्राफ्ट] अनुमानित कुल राशि 275 AED है।")).toBe(true);
  });

  it("catches the Urdu [ڈرافٹ] marker", () => {
    expect(hasUnfilledPlaceholders("[ڈرافٹ] تخمینی کل رقم 275 AED ہے۔")).toBe(true);
  });

  it("catches marker anywhere in the body, not just leading", () => {
    expect(hasUnfilledPlaceholders("Hi — [draft] check the price. Bye.")).toBe(true);
  });

  it("trims whitespace before the check", () => {
    expect(hasUnfilledPlaceholders("   [draft] hi")).toBe(true);
    expect(hasUnfilledPlaceholders("   normal text  ")).toBe(false);
  });

  it("empty / whitespace-only body is unsendable", () => {
    expect(hasUnfilledPlaceholders("")).toBe(true);
    expect(hasUnfilledPlaceholders("   ")).toBe(true);
    expect(hasUnfilledPlaceholders("\n\t\n")).toBe(true);
  });

  it("JC-2026-0098-class regression — the exact prod string ships as unsendable", () => {
    // The exact string that reached the customer over WhatsApp on
    // 2026-08-18 before this fix.
    const shipped =
      "[مسودة] إجمالي السعر التقديري هو ___ درهم شامل الضريبة. هل تريد المتابعة؟";
    expect(hasUnfilledPlaceholders(shipped)).toBe(true);
  });

  it("DRAFT_MARKERS enumerates every language variant used by draftFor()", () => {
    // Structural pin — if a new draft template lands in
    // receptionist.ts with a new language marker, add it here AND to
    // the constant. This test just documents the invariant.
    expect(DRAFT_MARKERS).toContain("[draft]");
    expect(DRAFT_MARKERS).toContain("[مسودة]");
    expect(DRAFT_MARKERS).toContain("[ड्राफ्ट]");
    expect(DRAFT_MARKERS).toContain("[ڈرافٹ]");
  });
});
