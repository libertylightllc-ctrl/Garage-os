/**
 * pluralize — CLDR category selection + fallback (AR 2026-08-21).
 *
 * Verifies that:
 *   1. Intl.PluralRules picks the right category per (locale, count)
 *      — en has {one, other}; ar has all six {zero, one, two, few,
 *      many, other}.
 *   2. The helper falls back _category → _other → bare when a
 *      specific key isn't in the dictionary. A partial translation
 *      never renders a raw i18n key.
 *   3. The {n} placeholder is substituted with the count.
 *
 * Pure unit — no DB, no framework.
 */

import { describe, expect, it } from "vitest";
import { pluralize } from "@/i18n/plural";
import type { MessageKey } from "@/i18n/config";

/** Build a tiny fake dictionary lookup — returns the key itself
 *  when unknown, matching how the real getT() behaves for missing
 *  entries. */
function makeT(entries: Record<string, string>) {
  return (k: MessageKey): string => entries[k] ?? k;
}

describe("pluralize — English (en)", () => {
  const t = makeT({
    unread_one: "1 unread",
    unread_other: "{n} unread",
  });

  it("count=1 → _one", () => {
    expect(pluralize(t, 1, "unread", "en")).toBe("1 unread");
  });

  it("count=0 → _other (English lumps zero into other)", () => {
    expect(pluralize(t, 0, "unread", "en")).toBe("0 unread");
  });

  it("count=2 → _other", () => {
    expect(pluralize(t, 2, "unread", "en")).toBe("2 unread");
  });

  it("count=100 → _other", () => {
    expect(pluralize(t, 100, "unread", "en")).toBe("100 unread");
  });
});

describe("pluralize — Arabic (ar)", () => {
  const t = makeT({
    session_one: "جلسة واحدة",
    session_two: "جلستان",
    session_few: "{n} جلسات",
    session_many: "{n} جلسة",
    session_other: "{n} جلسة",
  });

  it("count=1 → _one", () => {
    expect(pluralize(t, 1, "session", "ar")).toBe("جلسة واحدة");
  });

  it("count=2 → _two", () => {
    expect(pluralize(t, 2, "session", "ar")).toBe("جلستان");
  });

  it("count=3 → _few", () => {
    expect(pluralize(t, 3, "session", "ar")).toBe("3 جلسات");
  });

  it("count=10 → _few", () => {
    expect(pluralize(t, 10, "session", "ar")).toBe("10 جلسات");
  });

  it("count=11 → _many", () => {
    expect(pluralize(t, 11, "session", "ar")).toBe("11 جلسة");
  });

  it("count=100 → _other", () => {
    expect(pluralize(t, 100, "session", "ar")).toBe("100 جلسة");
  });
});

describe("pluralize — fallback chain", () => {
  it("missing _one falls back to _other", () => {
    const t = makeT({ x_other: "{n} things" });
    expect(pluralize(t, 1, "x", "en")).toBe("1 things");
  });

  it("missing _one AND _other falls back to the bare key", () => {
    const t = makeT({ x: "{n} items (fallback)" });
    expect(pluralize(t, 1, "x", "en")).toBe("1 items (fallback)");
  });

  it("no dictionary entry at all → returns the key name (visible bug, not silent)", () => {
    const t = makeT({});
    // The key itself is returned; no {n} in it so no substitution
    // happens. Renders as "missingKey" — a visible untranslated
    // string, easy to grep on and fix. Contrast with returning
    // "" or the count alone, which would look like a real UI.
    expect(pluralize(t, 5, "missingKey", "en")).toBe("missingKey");
  });
});

describe("pluralize — locale safety", () => {
  it("garbage locale doesn't blank the page — falls back to en 2-form", () => {
    const t = makeT({ unread_one: "1 unread", unread_other: "{n} unread" });
    expect(pluralize(t, 1, "unread", "not-a-real-locale")).toBe("1 unread");
    expect(pluralize(t, 5, "unread", "not-a-real-locale")).toBe("5 unread");
  });
});
