import { describe, it, expect } from "vitest";
import { detectLangFromBody } from "./lang-detect";

// AR 2026-08-19 — pin the detector against the incident that
// motivated it. Customer wrote "How much for the oil change and when
// can I bring the car?" in English; the AI replied in Arabic because
// the resolver read customer.lang ("ar" — schema default on every
// prod row) instead of the body. Every branch has a case here + a
// mixed-signal case that goes to null (caller routes to human
// approval on null).
describe("detectLangFromBody", () => {
  it("Hindi (Devanagari) → hi", () => {
    expect(detectLangFromBody("मेरी गाड़ी कब तैयार होगी?")).toBe("hi");
    expect(detectLangFromBody("अनुमानित कुल राशि 275 AED है।")).toBe("hi");
  });

  it("Arabic script without Urdu markers → ar", () => {
    expect(detectLangFromBody("متى ستكون السيارة جاهزة؟")).toBe("ar");
    expect(
      detectLangFromBody("إجمالي السعر التقديري هو 275 درهم شامل الضريبة."),
    ).toBe("ar");
  });

  it("Urdu-specific characters → ur (not ar, even though script overlaps)", () => {
    // "میری گاڑی کب تیار ہوگی؟" — mix of Arabic-script + Urdu
    // specifics (ی ‎ / ہ‎ / گ). Detector must NOT return ar.
    expect(detectLangFromBody("میری گاڑی کب تیار ہوگی؟")).toBe("ur");
    // Explicit Urdu ٹ, ڈ, ڑ.
    expect(detectLangFromBody("ٹھیک ہے, ڈرافٹ چھوڑ دیں")).toBe("ur");
  });

  it("Latin letters → en (regression: the JC exact scenario)", () => {
    // The exact string from INC 2026-08-18. Must resolve to "en"
    // not "ar" (the customer.lang fallback).
    expect(
      detectLangFromBody(
        "How much for the oil change and when can I bring the car?",
      ),
    ).toBe("en");
    expect(detectLangFromBody("is my car ready?")).toBe("en");
    expect(detectLangFromBody("Thank you.")).toBe("en");
  });

  it("empty / whitespace-only → null (nothing to detect from)", () => {
    expect(detectLangFromBody("")).toBeNull();
    expect(detectLangFromBody("   ")).toBeNull();
    expect(detectLangFromBody("\n\t")).toBeNull();
  });

  it("digits + punctuation only → null (not English)", () => {
    // A message of just a phone number is ambiguous — customer
    // could be Arabic-speaking, replied with just their number.
    // Better to route to human approval than to auto-reply in a
    // guessed language.
    expect(detectLangFromBody("+971 50 111 2222")).toBeNull();
    expect(detectLangFromBody("42.")).toBeNull();
    expect(detectLangFromBody("!!!")).toBeNull();
  });

  it("emojis alone → null", () => {
    // Common on WhatsApp — customer sends 👍 or 🙏 as
    // acknowledgement. Not a language signal.
    expect(detectLangFromBody("👍")).toBeNull();
    expect(detectLangFromBody("🙏 🙏 🙏")).toBeNull();
  });

  it("script precedence — Devanagari beats any coincident Latin", () => {
    // A Hindi message with a Latin-alphabet brand name embedded.
    // Devanagari should win.
    expect(detectLangFromBody("मेरी Toyota कब तैयार होगी?")).toBe("hi");
  });

  it("script precedence — Urdu marker beats Arabic-only characters", () => {
    // Mostly-Arabic text with one Urdu-specific character (ٹ)
    // still routes to ur. This is conservative on our side (Urdu
    // is a distinct speaker population) but the shape is right:
    // Urdu speakers see Urdu, not Arabic.
    expect(detectLangFromBody("سلام، گاڑی ٹھیک ہے؟")).toBe("ur");
  });

  it("script precedence — Arabic script (no Urdu marker) beats Latin brand names", () => {
    expect(detectLangFromBody("متى تكون سيارة Toyota جاهزة؟")).toBe("ar");
  });

  it("regression detector for the JC-2026-0098 wrong-language incident", () => {
    // The customer.lang fallback used to return "ar" for this
    // string. If a future refactor reintroduces that fallback, this
    // test fails loudly. Named commit chain: 2026-08-18 incident
    // → 2026-08-19 detector.
    const englishFromArabicSpeakingCustomer =
      "How much for the oil change and when can I bring the car?";
    expect(detectLangFromBody(englishFromArabicSpeakingCustomer)).toBe("en");
    // The engine used to return "ar" here because customer.lang
    // was "ar". Detector alone (no customer.lang input) returns "en".
  });
});
