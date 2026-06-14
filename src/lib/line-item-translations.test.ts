import { describe, it, expect } from "vitest";
import {
  translateLineDescription,
  _hasTranslation,
} from "./line-item-translations";

describe("translateLineDescription", () => {
  it("translates a known English term when locale is ar", () => {
    expect(translateLineDescription("Engine oil", "ar")).toBe("زيت محرك");
    expect(translateLineDescription("Labor charges", "ar")).toBe("أجور العمالة");
    expect(translateLineDescription("Discount", "ar")).toBe("خصم");
  });

  it("returns the original description unchanged for non-ar locales", () => {
    expect(translateLineDescription("Engine oil", "en")).toBe("Engine oil");
    expect(translateLineDescription("Engine oil", "hi")).toBe("Engine oil");
    expect(translateLineDescription("Engine oil", "ur")).toBe("Engine oil");
  });

  it("normalizes case / whitespace before lookup", () => {
    expect(translateLineDescription("  engine oil  ", "ar")).toBe("زيت محرك");
    expect(translateLineDescription("ENGINE  OIL", "ar")).toBe("زيت محرك");
    expect(translateLineDescription("Engine\tOil", "ar")).toBe("زيت محرك");
  });

  it("passes unknown descriptions through unchanged (custom items)", () => {
    expect(translateLineDescription("WD-40 spray", "ar")).toBe("WD-40 spray");
    expect(translateLineDescription("Custom part XYZ-123", "ar")).toBe(
      "Custom part XYZ-123",
    );
  });

  it("handles left/right variants explicitly (separate entries)", () => {
    expect(translateLineDescription("Ball joint right", "ar")).toBe(
      "ركبة محورية يمين",
    );
    expect(translateLineDescription("Ball joint left", "ar")).toBe(
      "ركبة محورية يسار",
    );
    // Bare 'Ball joint' also matches.
    expect(translateLineDescription("Ball joint", "ar")).toBe("ركبة محورية");
  });

  it("preserves empty strings without throwing", () => {
    expect(translateLineDescription("", "ar")).toBe("");
    expect(translateLineDescription("", "en")).toBe("");
  });

  it("never mutates the input", () => {
    const input = "Engine Oil";
    translateLineDescription(input, "ar");
    expect(input).toBe("Engine Oil");
  });

  it("_hasTranslation reflects dictionary state", () => {
    expect(_hasTranslation("engine oil")).toBe(true);
    expect(_hasTranslation("Engine Oil")).toBe(true); // normalized
    expect(_hasTranslation("unknown service xyz")).toBe(false);
  });
});
