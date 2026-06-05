import { describe, it, expect } from "vitest";
import { bcp47ForLocale, appendTranscript } from "./dictate";

describe("voice dictation helpers", () => {
  it("maps app locale → BCP-47", () => {
    expect(bcp47ForLocale("en")).toBe("en-US");
    expect(bcp47ForLocale("ar")).toBe("ar-AE");
  });

  it("falls back to en-US for unknown locale (better to listen than reject)", () => {
    expect(bcp47ForLocale("hi")).toBe("en-US");
    expect(bcp47ForLocale("")).toBe("en-US");
    expect(bcp47ForLocale(null)).toBe("en-US");
    expect(bcp47ForLocale(undefined)).toBe("en-US");
  });

  it("appends transcript with a space and never erases existing text", () => {
    expect(appendTranscript("", "hello")).toBe("hello");
    expect(appendTranscript("hello", "world")).toBe("hello world");
    expect(appendTranscript("hello ", "world")).toBe("hello world"); // trims trailing space
    expect(appendTranscript("hello", " world ")).toBe("hello world"); // trims fragment
    expect(appendTranscript("hello", "")).toBe("hello"); // empty fragment no-op
    expect(appendTranscript("hello", "   ")).toBe("hello"); // whitespace-only no-op
  });

  it("handles null / undefined as empty", () => {
    expect(appendTranscript(null as never, "x")).toBe("x");
    expect(appendTranscript("x", null as never)).toBe("x");
  });
});
