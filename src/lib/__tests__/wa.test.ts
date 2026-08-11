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

    // Country-code gate added 2026-08-10 after INV-2026-0039 fixture leak.
    // Before this, 8-15 digits + digit-only was the whole check, so a raw
    // "509633280" passed straight through and wa.me opened a chat with
    // nobody. The gate insists on a recognised GCC country code prefix.
    describe("GCC country-code gate (2026-08-10)", () => {
        it("rejects 9-digit UAE mobile with the leading 0 lost (the AHMED case)", () => {
            // Repro of the real INV-2026-0039 recipient we found in prod.
            expect(normalizeToE164("509633280")).toBeNull();
        });
        it("rejects a foreign (UK) E.164 — not in GCC", () => {
            expect(normalizeToE164("+441234567890")).toBeNull();
        });
        it("rejects a bare 8-digit domestic number", () => {
            expect(normalizeToE164("50123456")).toBeNull();
        });
        it("accepts every listed GCC country code", () => {
            expect(normalizeToE164("971501234567")).toBe("971501234567"); // UAE
            expect(normalizeToE164("966501234567")).toBe("966501234567"); // KSA
            expect(normalizeToE164("968901234567")).toBe("968901234567"); // Oman
            expect(normalizeToE164("974501234567")).toBe("974501234567"); // Qatar
            expect(normalizeToE164("973301234567")).toBe("973301234567"); // Bahrain
            expect(normalizeToE164("965501234567")).toBe("965501234567"); // Kuwait
        });
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

    // Contact-picker branch — added 2026-08-11 after AR flagged the
    // dead-end button on bad customer phones. `null` phone → wa.me
    // opens its native contact picker with the message pre-filled;
    // the sender chooses who to send to before tapping Send.
    describe("contact-picker branch (phone = null)", () => {
        it("null phone → picker URL, no number segment", () => {
            expect(buildWaMeUrl(null, "Hi there")).toBe(
                "https://wa.me/?text=Hi%20there",
            );
        });
        it("null phone still encodes the message correctly", () => {
            expect(buildWaMeUrl(null, "AED 100 & 50%")).toBe(
                "https://wa.me/?text=AED%20100%20%26%2050%25",
            );
        });
        it("null phone with Arabic message survives decode round-trip", () => {
            const out = buildWaMeUrl(null, "مرحباً");
            expect(out.startsWith("https://wa.me/?text=")).toBe(true);
            expect(decodeURIComponent(out.split("?text=")[1])).toBe("مرحباً");
        });
        it("valid-phone case still returns direct-chat URL — no regression", () => {
            expect(buildWaMeUrl("971501234567", "Hi")).toBe(
                "https://wa.me/971501234567?text=Hi",
            );
        });
    });
});

describe("invoiceMessage — structured template (matches PO pattern, AR 2026-08-10)", () => {
    const base = {
        customer: { name: "Ahmed", lang: "en" as const },
        garage: { name: "Deira Central Motors" },
        vehicle: {
            make: "Mercedes",
            model: "300",
            year: 2013,
            plate: "B 22583",
            vin: null,
            engineSize: null,
            fuelType: null,
            jobNumber: 2,
        },
        invoice: {
            number: "INV-2026-0001",
            subtotal: 1245.0,
            vatAmount: 62.25,
            total: 1307.25,
            lines: [
                { qty: 1, description: "Front brake pad" },
                { qty: 1, description: "Rear brake pads" },
                { qty: 6, description: "Engine oil 6 litter" },
            ],
        },
        appUrl: "https://garageos.shop",
        invoiceId: "4G5CopWK95wRCb-6PfSXx7yAmkuknA_m",
    };

    it("EN: paragraphs = greeting, heading, For:, items, totals, closing, link (paragraph order)", () => {
        const msg = invoiceMessage(base);
        // Seven paragraphs joined by blank lines — matches PO shape.
        const paras = msg.split("\n\n");
        expect(paras[0]).toBe("Hi Ahmed,");
        expect(paras[1]).toBe("Tax Invoice INV-2026-0001 — from Deira Central Motors");
        expect(paras[2]).toBe("For: Mercedes 300 2013 · B 22583 · JC-2");
        expect(paras[3]).toBe("1 × Front brake pad\n1 × Rear brake pads\n6 × Engine oil 6 litter");
        expect(paras[4]).toBe("Subtotal: AED 1245.00\nVAT (5%): AED 62.25\nTotal: AED 1307.25");
        expect(paras[5]).toBe("Please pay at the garage (cash or card).");
        expect(paras[6]).toBe("View invoice: https://garageos.shop/c/invoice/4G5CopWK95wRCb-6PfSXx7yAmkuknA_m");
    });

    it("AR: mirrors the EN paragraphs with `مرحباً`, `فاتورة ضريبية`, `لأجل`, totals block, closing prompt, `عرض الفاتورة`", () => {
        const msg = invoiceMessage({ ...base, customer: { name: "أحمد", lang: "ar" } });
        expect(msg).toContain("مرحباً أحمد،");
        expect(msg).toContain("فاتورة ضريبية INV-2026-0001 — Deira Central Motors");
        expect(msg).toContain("لأجل: Mercedes 300 2013 · B 22583 · بطاقة عمل رقم 2");
        // AR money format: `1245.00 درهم` (word after digits), per the
        // existing formatMoney helper — matches the purchaseOrderMessage
        // Arabic branch and the customer invoice page's Arabic rendering.
        expect(msg).toContain("المجموع الفرعي: 1245.00 درهم");
        expect(msg).toContain("ضريبة القيمة المضافة (٥٪): 62.25 درهم");
        expect(msg).toContain("الإجمالي: 1307.25 درهم");
        expect(msg).toContain("يرجى الدفع في الكراج (نقداً أو بالبطاقة).");
        expect(msg).toMatch(/عرض الفاتورة: https:\/\/garageos\.shop\/c\/invoice\//);
    });

    it("VIN + engine + fuel: each optional field lands in the vehicle line when present", () => {
        // Regression pin for the "For:" shape matching the PO sample AR
        // sent: "Toyota Cammary 2014 · Y12345 · VIN WF0BB2KF1ELY11017 ·
        // 1.8 PETROL · JC-81". The invoice builder now mirrors it.
        const msg = invoiceMessage({
            ...base,
            vehicle: {
                make: "Toyota",
                model: "Cammary",
                year: 2014,
                plate: "Y12345",
                vin: "WF0BB2KF1ELY11017",
                engineSize: "1.8",
                fuelType: "PETROL",
                jobNumber: 81,
            },
        });
        expect(msg).toContain("For: Toyota Cammary 2014 · Y12345 · VIN WF0BB2KF1ELY11017 · 1.8 PETROL · JC-81");
    });

    it("falls back to English when lang is missing or unknown", () => {
        const msg1 = invoiceMessage({ ...base, customer: { name: "Ahmed", lang: null } });
        expect(msg1).toContain("Hi Ahmed,");
        expect(msg1).toContain("Tax Invoice INV-2026-0001");

        const msg2 = invoiceMessage({ ...base, customer: { name: "Ahmed", lang: "hi" } });
        expect(msg2).toContain("Hi Ahmed,");
    });

    it("money renders with 2 decimals even for whole numbers", () => {
        const msg = invoiceMessage({
            ...base,
            invoice: { ...base.invoice, subtotal: 300, vatAmount: 15, total: 315 },
        });
        expect(msg).toContain("Subtotal: AED 300.00");
        expect(msg).toContain("VAT (5%): AED 15.00");
        expect(msg).toContain("Total: AED 315.00");
    });

    it("empty vehicle bits → no 'For:' paragraph (never render a naked 'For:')", () => {
        const msg = invoiceMessage({
            ...base,
            vehicle: {
                make: "", model: "", year: null, plate: null, vin: null,
                engineSize: null, fuelType: null, jobNumber: null,
            },
        });
        expect(msg).not.toContain("For:");
        // Adjacent paragraphs (heading + items) still separated by \n\n,
        // never left with a stray blank line where "For:" would go.
        expect(msg).not.toMatch(/\n\n\n\n/);
    });

    it("qty renders as plain number (1 not 1.00, 6 not 6.00) — matches PO builder", () => {
        const msg = invoiceMessage(base);
        expect(msg).toContain("1 × Front brake pad");
        expect(msg).toContain("6 × Engine oil 6 litter");
        expect(msg).not.toContain("1.00 ×");
        expect(msg).not.toContain("6.00 ×");
    });

    it("URL matches whichever token shape the caller passes — no interpretation of shape", () => {
        // Phase-2 raw publicToken (base64url, no ~).
        expect(invoiceMessage(base)).toContain("View invoice: https://garageos.shop/c/invoice/4G5CopWK95wRCb-6PfSXx7yAmkuknA_m");
        // Phase-1 HMAC-shaped token (has ~) survives through unchanged.
        const withHmac = invoiceMessage({ ...base, invoiceId: "cmrj7l1lz000004jy27dhe88a~OEuUaMU7I3GHZDKmJszug1DV" });
        expect(withHmac).toContain("View invoice: https://garageos.shop/c/invoice/cmrj7l1lz000004jy27dhe88a~OEuUaMU7I3GHZDKmJszug1DV");
    });
});

describe("purchaseOrderMessage — supplier PO / RFQ WhatsApp body", () => {
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
        perLineUnpriced: [false, false],
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
        // PO body has no RFQ closing prompt.
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
        // Trimmed and preceded by a blank line so it reads as its own
        // paragraph on WhatsApp. Trailing whitespace is not asserted —
        // the note may be the last block in the message.
        expect(msg).toContain("\n\nPlease deliver by Thursday.");
        expect(msg).not.toContain("Please deliver by Thursday.  ");
    });

    it("note that is blank / whitespace → skipped (no double newline gap)", () => {
        const msg = purchaseOrderMessage({ ...basePo, note: "   " });
        // The heading and items are still adjacent — orphan paragraph
        // must not appear. Message paragraphs: greeting / heading /
        // items / link. Four blocks separated by \n\n = three splits.
        expect(msg.split("\n\n").length).toBeLessThanOrEqual(4);
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
        // Items must NOT get the inline (JC-N · Make Model) suffix — the
        // header already names the one vehicle.
        expect(msg).not.toMatch(/Front brake pads.*\(JC-42/);
        expect(msg).not.toContain("(no vehicle linked)");
    });

    it("single-vehicle + some unresolved lines: unresolved lines still tagged '(no vehicle linked)'", () => {
        // Regression: previously the singleVehicle short-circuit
        // returned `base` for every line, which meant unresolved
        // lines silently read as belonging to the header's car.
        // Fix: only skip the tag when the line ITSELF resolves to
        // the single vehicle.
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

    it("mixed pricing — unpriced lines get '(please quote)' appended AFTER any vehicle tag, priced lines stay bare", () => {
        // Simulating a mixed RFQ where the 2nd line is unpriced. Both
        // lines resolve to the same vehicle (singleVehicle shape), so
        // neither line carries a vehicle inline tag; the "please
        // quote" marker is the only per-line differentiator.
        const msg = purchaseOrderMessage({
            ...singleVehiclePo,
            perLineUnpriced: [false, true],
        });
        expect(msg).toContain("2 × Front brake pads");
        expect(msg).not.toContain("2 × Front brake pads (please quote)");
        expect(msg).toContain("1 × Battery 70Ah (please quote)");
    });

    it("mixed pricing + multi-vehicle — '(please quote)' rides AFTER the (JC-N · Make Model) inline tag on unpriced lines", () => {
        // The marker must survive alongside the vehicle context —
        // both belong to the same line and both should reach the
        // supplier.
        const msg = purchaseOrderMessage({
            ...multiVehiclePo,
            perLineUnpriced: [true, false],
        });
        expect(msg).toContain("2 × Front brake pads (JC-42 · Nissan Patrol) (please quote)");
        expect(msg).toContain("1 × Battery 70Ah (JC-43 · Toyota Land Cruiser)");
        expect(msg).not.toContain("1 × Battery 70Ah (JC-43 · Toyota Land Cruiser) (please quote)");
    });

    it("mixed pricing (AR): unpriced lines get '(برجاء إفادتنا بالسعر)'", () => {
        const msg = purchaseOrderMessage({
            ...singleVehiclePo,
            lang: "ar",
            doc: { title: "طلب عرض سعر", number: "#RFQ-01", isRfq: true },
            supplier: { contactPerson: "أحمد" },
            perLineUnpriced: [false, true],
        });
        expect(msg).toContain("1 × Battery 70Ah (برجاء إفادتنا بالسعر)");
        expect(msg).not.toContain("2 × Front brake pads (برجاء إفادتنا بالسعر)");
    });

    it("marker is NEVER injected into the description field — description passes through verbatim", () => {
        // Regression contract for the "concatenated string leaks to
        // WhatsApp" bug shape (see 'fixture — no inventory link'
        // history). If a future refactor moved the marker into
        // `lines[i].description`, the input description would
        // survive verbatim ("Front brake pads"), and the marker
        // would sit AFTER it as its own segment — which is what
        // the current builder does and what this test pins.
        const msg = purchaseOrderMessage({
            ...basePo,
            lines: [
                { qty: 1, description: "SPECIAL_DESCRIPTION_MARKER" },
                { qty: 1, description: "SPECIAL_DESCRIPTION_MARKER" },
            ],
            perLineUnpriced: [false, true],
        });
        // Description appears twice, both times exactly as passed in.
        // On the unpriced line the marker follows as its own segment,
        // separated by whitespace — not concatenated into the string.
        const occurrences = (msg.match(/SPECIAL_DESCRIPTION_MARKER/g) || []).length;
        expect(occurrences).toBe(2);
        expect(msg).not.toContain("SPECIAL_DESCRIPTION_MARKER(please quote)");
        expect(msg).not.toContain("SPECIAL_DESCRIPTION_MARKER (quote please)");
    });

    it("both channels get IDENTICAL body — WhatsApp URL-encoded body equals email plain-text body", () => {
        // Belt-and-braces on the "channels can't drift" contract.
        // The email action passes `messageBody` directly as its text
        // body; the WhatsApp button URL-encodes the same `messageBody`
        // into wa.me?text=…. Decoding the URL must give back the
        // exact plain-text body.
        const msg = purchaseOrderMessage(basePo);
        const waEncoded = `https://wa.me/97145551234?text=${encodeURIComponent(msg)}`;
        const decoded = decodeURIComponent(waEncoded.split("?text=")[1]);
        expect(decoded).toBe(msg);
    });
});
