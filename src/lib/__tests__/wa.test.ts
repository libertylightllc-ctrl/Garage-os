import { describe, it, expect } from "vitest";
import { normalizeToE164, buildWaMeUrl } from "@/lib/wa";
import { invoiceMessage } from "@/lib/wa-templates";

describe("normalizeToE164 — all 8 cases", () => {
    it("full E.164 with plus", () => {
        expect(normalizeToE164("+971501234567")).toBe("971501234567");
    });
    it("full E.164 without plus", () => {
        expect(normalizeToE164("971501234567")).toBe("971501234567");
    });
    it("international with 00 prefix", () => {
        expect(normalizeToE164("00971501234567")).toBe("971501234567");
    });
    it("local UAE mobile with leading 0 → prepends 971", () => {
        expect(normalizeToE164("0501234567")).toBe("971501234567");
    });
    it("invalid — too short", () => {
        expect(normalizeToE164("123")).toBeNull();
    });
    it("empty / whitespace-only", () => {
        expect(normalizeToE164("")).toBeNull();
        expect(normalizeToE164("   ")).toBeNull();
        expect(normalizeToE164(null)).toBeNull();
        expect(normalizeToE164(undefined)).toBeNull();
    });
    it("noise — spaces, dashes, parens, dots", () => {
        expect(normalizeToE164("+971 50-123.4567")).toBe("971501234567");
        expect(normalizeToE164("+971 (50) 123 4567")).toBe("971501234567");
    });
    it("non-digit contamination — letters get stripped, then validated", () => {
        // Letters stripped, remaining digits are 971501234567 → valid.
        expect(normalizeToE164("+971 50 abc 1234567")).toBe("971501234567");
        // Nothing but letters → null.
        expect(normalizeToE164("abcdef")).toBeNull();
    });

    it("custom default country code", () => {
        expect(normalizeToE164("0501234567", "966")).toBe("966501234567");
    });
    it("does not double-prepend when already E.164", () => {
        expect(normalizeToE164("+971501234567", "966")).toBe("971501234567");
    });
    it("rejects absurdly long input", () => {
        expect(normalizeToE164("+1234567890123456")).toBeNull();
    });
});

describe("buildWaMeUrl — URL encoding correctness", () => {
    it("basic ASCII", () => {
        expect(buildWaMeUrl("971501234567", "Hi there")).toBe(
            "https://wa.me/971501234567?text=Hi%20there",
        );
    });
    it("escapes special chars", () => {
        expect(buildWaMeUrl("971501234567", "AED 100 & 50%")).toBe(
            "https://wa.me/971501234567?text=AED%20100%20%26%2050%25",
        );
    });
    it("encodes Arabic without mangling it", () => {
        const out = buildWaMeUrl("971501234567", "مرحباً");
        // %-triples of the UTF-8 bytes for 'مرحباً'.
        expect(out).toContain("https://wa.me/971501234567?text=");
        // Decodes back to the original string.
        const decoded = decodeURIComponent(out.split("?text=")[1]);
        expect(decoded).toBe("مرحباً");
    });
    it("encodes newlines and pipe", () => {
        expect(buildWaMeUrl("971501234567", "line1\nline2|end")).toBe(
            "https://wa.me/971501234567?text=line1%0Aline2%7Cend",
        );
    });
});

describe("invoiceMessage — template rendering", () => {
    const base = {
        customer: { name: "Ahmed", lang: "en" as const },
        vehicle: { make: "Toyota", model: "Land Cruiser" },
        invoice: { total: 535.5, number: 42 },
        appUrl: "https://garageos.shop",
        invoiceId: "abc123",
    };

    it("English format", () => {
        const msg = invoiceMessage(base);
        expect(msg).toBe(
            "Hi Ahmed, your invoice for the Toyota Land Cruiser is ready. Total AED 535.50. View & pay: https://garageos.shop/c/invoice/abc123",
        );
    });

    it("Arabic format", () => {
        const msg = invoiceMessage({
            ...base,
            customer: { name: "أحمد", lang: "ar" },
        });
        expect(msg).toBe(
            "مرحباً أحمد، فاتورتك لـ Toyota Land Cruiser جاهزة. الإجمالي 535.50 درهم. عرض والدفع: https://garageos.shop/c/invoice/abc123",
        );
    });

    it("falls back to English when lang is missing or unknown", () => {
        const msg1 = invoiceMessage({
            ...base,
            customer: { name: "Ahmed", lang: null },
        });
        expect(msg1).toContain("Hi Ahmed");
        expect(msg1).toContain("AED 535.50");

        const msg2 = invoiceMessage({
            ...base,
            customer: { name: "Ahmed", lang: "hi" },
        });
        expect(msg2).toContain("Hi Ahmed");
    });

    it("formats money to 2 decimals even with whole numbers", () => {
        const msg = invoiceMessage({
            ...base,
            invoice: { total: 300, number: 1 },
        });
        expect(msg).toContain("AED 300.00");
    });
});
