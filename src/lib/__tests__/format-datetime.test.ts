import { describe, it, expect } from "vitest";
import {
    countryToTimeZone,
    fmtDateTime,
    fmtDate,
    fmtTime,
    fmtMonthYear,
} from "@/lib/format-datetime";

/**
 * The whole reason this module exists is to fix the UTC-slice / silent-
 * UTC-toLocaleString bug that shipped in 74a3367 and aed803d. So the
 * regression pins here are TIMEZONE assertions first, format shape
 * second.
 *
 * Fixed-instant pin (from AR, 2026-07-23):
 *   2026-07-23T03:29:00.000Z  as-viewed-in Asia/Dubai (+04:00)
 *   MUST render "Jul 23, 2026, 7:29 AM" — NOT "Jul 23, 2026, 3:29 AM".
 * If the wall-clock digits go back to 3:29, the timezone plumbing
 * broke and the whole point of the migration was lost.
 */

const CHECK_IN_UTC = new Date("2026-07-23T03:29:00.000Z");

describe("countryToTimeZone", () => {
    it("maps each GCC-6 country to its IANA timezone", () => {
        expect(countryToTimeZone("UAE")).toBe("Asia/Dubai");
        expect(countryToTimeZone("KSA")).toBe("Asia/Riyadh");
        expect(countryToTimeZone("Kuwait")).toBe("Asia/Kuwait");
        expect(countryToTimeZone("Bahrain")).toBe("Asia/Bahrain");
        expect(countryToTimeZone("Qatar")).toBe("Asia/Qatar");
        expect(countryToTimeZone("Oman")).toBe("Asia/Muscat");
    });

    it("falls back to Asia/Dubai on unknown country (matches Garage.country default)", () => {
        // If a legacy row has some unrecognised string the customer-
        // facing invoice must not 500. Silent fallback is the choice.
        expect(countryToTimeZone("")).toBe("Asia/Dubai");
        expect(countryToTimeZone("Antarctica")).toBe("Asia/Dubai");
        expect(countryToTimeZone("uae")).toBe("Asia/Dubai"); // case-sensitive, matches enum values on the schema
    });
});

describe("fmtDateTime — the regression pin", () => {
    it("renders 03:29 UTC as 7:29 AM in Asia/Dubai (this is the bug 74a3367 shipped)", () => {
        const out = fmtDateTime(CHECK_IN_UTC, "en", "Asia/Dubai");
        // Substring checks so a Node ICU update that adds/removes a
        // comma or space doesn't flap the test. The failure we care
        // about is the WALL-CLOCK HOUR, not the exact separators.
        expect(out).toContain("Jul");
        expect(out).toContain("23");
        expect(out).toContain("2026");
        expect(out).toContain("7:29");
        expect(out).not.toContain("3:29"); // the bug
    });

    it("renders the same instant as 3:29 AM in UTC (proves timeZone param is doing work)", () => {
        const out = fmtDateTime(CHECK_IN_UTC, "en", "UTC");
        expect(out).toContain("3:29");
        expect(out).not.toContain("7:29");
    });

    it("respects locale (Arabic renders arabic-indic digits and month name)", () => {
        const out = fmtDateTime(CHECK_IN_UTC, "ar", "Asia/Dubai");
        // Arabic locale uses arabic-indic digits (٠-٩) by default via
        // toLocaleString. The month name is localised too. Assert
        // shape, not exact glyphs, so ICU updates don't flap.
        expect(out.length).toBeGreaterThan(0);
        // A meaningful signal: the Arabic output MUST NOT match the
        // English one for the same instant. If it does, the locale
        // arg was dropped somewhere.
        const en = fmtDateTime(CHECK_IN_UTC, "en", "Asia/Dubai");
        expect(out).not.toBe(en);
    });

    it("KSA timezone renders 03:29 UTC as 6:29 AM (+03:00 vs UAE's +04:00)", () => {
        // Cross-country regression pin. KSA is one hour behind Dubai.
        // This asserts the country → timezone plumbing produces
        // different wall-clocks in different countries as expected.
        const out = fmtDateTime(CHECK_IN_UTC, "en", countryToTimeZone("KSA"));
        expect(out).toContain("6:29");
    });
});

describe("fmtDate", () => {
    it("renders 2026-07-23 in Asia/Dubai (safe — well inside the day)", () => {
        const out = fmtDate(CHECK_IN_UTC, "en", "Asia/Dubai");
        expect(out).toContain("Jul");
        expect(out).toContain("23");
        expect(out).toContain("2026");
    });

    it("returns the PRIOR day when a near-midnight local instant is rendered in UTC (the bug we're fixing)", () => {
        // 2026-07-24T01:00:00+04:00 Dubai = 2026-07-23T21:00:00Z UTC.
        // UTC-slice renders that as 2026-07-23. Asia/Dubai renders
        // 2026-07-24. This is the class of bug the migration fixes.
        const nearMidnightUtc = new Date("2026-07-23T21:00:00.000Z");
        expect(fmtDate(nearMidnightUtc, "en", "UTC")).toContain("23");
        expect(fmtDate(nearMidnightUtc, "en", "Asia/Dubai")).toContain("24");
    });
});

describe("fmtTime", () => {
    it("renders 7:29 AM in Asia/Dubai", () => {
        const out = fmtTime(CHECK_IN_UTC, "en", "Asia/Dubai");
        expect(out).toContain("7:29");
    });
});

describe("fmtMonthYear", () => {
    it("renders 'July 2026' for an instant safely inside July Dubai", () => {
        const out = fmtMonthYear(CHECK_IN_UTC, "en", "Asia/Dubai");
        expect(out.toLowerCase()).toContain("july");
        expect(out).toContain("2026");
    });

    it("labels an instant near the month boundary by its LOCAL month", () => {
        // 2026-08-01T02:00:00+04:00 Dubai = 2026-07-31T22:00:00Z.
        // Asia/Dubai formatting must render this as August 2026.
        // This isn't the reminders-page fix (that's the boundary
        // math, logged as a follow-up) — but it pins the format
        // helper's behaviour so the follow-up can rely on it.
        const boundary = new Date("2026-07-31T22:00:00.000Z");
        const dubaiOut = fmtMonthYear(boundary, "en", "Asia/Dubai");
        const utcOut = fmtMonthYear(boundary, "en", "UTC");
        expect(dubaiOut.toLowerCase()).toContain("august");
        expect(utcOut.toLowerCase()).toContain("july");
    });
});
