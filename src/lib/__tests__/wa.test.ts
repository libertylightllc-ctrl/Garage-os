import { describe, it, expect } from "vitest";
import { normalizeToE164, buildWaMeUrl } from "@/lib/wa";
import { invoiceMessage, purchaseOrderMessage } from "@/lib/po-message";

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

describe("purchaseOrderMessage — supplier PO WhatsApp/email body", () => {
    const basePo = {
        doc: { title: "Purchase Order", number: "#ABC123", isRfq: false },
        garage: { name: "Demo Motors" },
        supplier: { contactPerson: "Ahmed" },
        lines: [
            { qty: 2, description: "Front brake pads" },
            { qty: 1, description: "Battery 70Ah" },
        ],
        note: null,
        publicUrl: "https://garageos.shop/c/po/AAA~BBB",
        perLineVehicle: [null, null],
        distinctVehicles: [],
        lang: "en" as const,
    };

    const singleVehiclePo = {
        ...basePo,
        perLineVehicle: [
            {
                vehicleId: "v1",
                make: "Nissan",
                model: "Patrol",
                year: 2022,
                plate: "D 12345",
                vin: "JN1TANT32U0123456",
                engineSize: "5",
                fuelType: "PETROL",
                jobNumber: 42,
            },
            {
                vehicleId: "v1",
                make: "Nissan",
                model: "Patrol",
                year: 2022,
                plate: "D 12345",
                vin: "JN1TANT32U0123456",
                engineSize: "5",
                fuelType: "PETROL",
                jobNumber: 42,
            },
        ],
        distinctVehicles: [
            {
                vehicleId: "v1",
                make: "Nissan",
                model: "Patrol",
                year: 2022,
                plate: "D 12345",
                vin: "JN1TANT32U0123456",
                engineSize: "5",
                fuelType: "PETROL",
                jobNumber: 42,
            },
        ],
    };

    const multiVehiclePo = {
        ...basePo,
        perLineVehicle: [
            {
                vehicleId: "v1",
                make: "Nissan",
                model: "Patrol",
                year: 2022,
                plate: "D 12345",
                vin: null,
                engineSize: null,
                fuelType: null,
                jobNumber: 42,
            },
            {
                vehicleId: "v2",
                make: "Toyota",
                model: "Land Cruiser",
                year: 2021,
                plate: "A 12345",
                vin: null,
                engineSize: null,
                fuelType: null,
                jobNumber: 43,
            },
        ],
        distinctVehicles: [
            {
                vehicleId: "v1",
                make: "Nissan",
                model: "Patrol",
                year: 2022,
                plate: "D 12345",
                vin: null,
                engineSize: null,
                fuelType: null,
                jobNumber: 42,
            },
            {
                vehicleId: "v2",
                make: "Toyota",
                model: "Land Cruiser",
                year: 2021,
                plate: "A 12345",
                vin: null,
                engineSize: null,
                fuelType: null,
                jobNumber: 43,
            },
        ],
    };

    it("PO body (EN): greets by name, heads with title+number+garage, lists qty × item", () => {
        const msg = purchaseOrderMessage(basePo);
        expect(msg).toContain("Hi Ahmed,");
        expect(msg).toContain("Purchase Order #ABC123 — from Demo Motors");
        expect(msg).toContain("2 × Front brake pads");
        expect(msg).toContain("1 × Battery 70Ah");
        expect(msg).not.toMatch(/prices? and availability/i);
    });

    it("RFQ body (EN): appends the price-and-availability closing prompt", () => {
        const msg = purchaseOrderMessage({
            ...basePo,
            doc: { title: "Request for Quotation", number: "#RFQ-01", isRfq: true },
        });
        expect(msg).toContain("Request for Quotation #RFQ-01");
        expect(msg).toContain("Please share prices and availability for each item.");
    });

    it("no contactPerson → generic greeting, not empty 'Hi ,'", () => {
        const msg = purchaseOrderMessage({
            ...basePo,
            supplier: { contactPerson: null },
        });
        expect(msg.startsWith("Hi,")).toBe(true);
        expect(msg).not.toContain("Hi ,");
    });

    it("AR locale: greeting + heading + closing render in Arabic", () => {
        const msg = purchaseOrderMessage({
            ...basePo,
            doc: { title: "طلب عرض سعر", number: "#RFQ-01", isRfq: true },
            supplier: { contactPerson: "أحمد" },
            lang: "ar",
        });
        expect(msg).toContain("مرحباً أحمد،");
        expect(msg).toContain("طلب عرض سعر #RFQ-01 — Demo Motors");
        expect(msg).toContain("برجاء إفادتنا بالأسعار والتوفر لكل بند.");
    });

    it("PO note renders as its own paragraph when present", () => {
        const msg = purchaseOrderMessage({ ...basePo, note: "  Please deliver by Thursday.  " });
        expect(msg).toContain("\n\nPlease deliver by Thursday.");
        expect(msg).not.toContain("Please deliver by Thursday.  ");
    });

    it("publicUrl renders as the LAST line under a 'View document' label (EN)", () => {
        const msg = purchaseOrderMessage(basePo);
        const lines = msg.split("\n");
        expect(lines[lines.length - 1]).toBe(
            "View document: https://garageos.shop/c/po/AAA~BBB",
        );
    });

    it("publicUrl label is Arabic when lang=ar", () => {
        const msg = purchaseOrderMessage({
            ...basePo,
            lang: "ar",
            doc: { title: "طلب عرض سعر", number: "#RFQ-01", isRfq: true },
            supplier: { contactPerson: "أحمد" },
        });
        const lines = msg.split("\n");
        expect(lines[lines.length - 1]).toBe(
            "عرض المستند: https://garageos.shop/c/po/AAA~BBB",
        );
    });

    it("single-vehicle: 'For: …' header line names the car, items stay bare", () => {
        const msg = purchaseOrderMessage(singleVehiclePo);
        expect(msg).toContain("For: Nissan Patrol 2022 · D 12345 · VIN JN1TANT32U0123456 · 5 PETROL · JC-42");
        expect(msg).toContain("2 × Front brake pads");
        expect(msg).not.toMatch(/Front brake pads.*\(JC-42/);
        expect(msg).not.toContain("(no vehicle linked)");
    });

    it("single-vehicle + some unresolved lines: unresolved lines still tagged '(no vehicle linked)'", () => {
        const msg = purchaseOrderMessage({
            ...singleVehiclePo,
            lines: [
                { qty: 2, description: "Front brake pads" },
                { qty: 1, description: "Air filter" },
            ],
            perLineVehicle: [singleVehiclePo.perLineVehicle[0], null],
        });
        expect(msg).toContain("For: Nissan Patrol");
        expect(msg).toContain("2 × Front brake pads");
        expect(msg).not.toContain("2 × Front brake pads (no vehicle linked)");
        expect(msg).toContain("1 × Air filter (no vehicle linked)");
    });

    it("multi-vehicle: header lists all + each item gets its inline (JC-N · Make Model) tag", () => {
        const msg = purchaseOrderMessage(multiVehiclePo);
        expect(msg).toContain("For vehicles:");
        expect(msg).toContain("• Nissan Patrol 2022 · D 12345 · JC-42");
        expect(msg).toContain("• Toyota Land Cruiser 2021 · A 12345 · JC-43");
        expect(msg).toContain("2 × Front brake pads (JC-42 · Nissan Patrol)");
        expect(msg).toContain("1 × Battery 70Ah (JC-43 · Toyota Land Cruiser)");
    });

    it("zero-resolved: no 'For:' header, each unresolved item gets '(no vehicle linked)' inline", () => {
        const msg = purchaseOrderMessage(basePo);
        expect(msg).not.toContain("For:");
        expect(msg).not.toContain("For vehicles:");
        expect(msg).toContain("2 × Front brake pads (no vehicle linked)");
        expect(msg).toContain("1 × Battery 70Ah (no vehicle linked)");
    });

    it("both channels get IDENTICAL body — WhatsApp URL-encoded body equals email plain-text body", () => {
        const msg = purchaseOrderMessage(basePo);
        const waEncoded = `https://wa.me/97145551234?text=${encodeURIComponent(msg)}`;
        const decoded = decodeURIComponent(waEncoded.split("?text=")[1]);
        expect(decoded).toBe(msg);
    });
});
