import { describe, it, expect } from "vitest";
import {
    parseReceiveMode,
    shouldUpdateEstimateCost,
    compareReceiptToInvoice,
    DEFAULT_MODE_FOR_UNLINKED,
} from "./direct-fit-receipt";

describe("parseReceiveMode", () => {
    // AR 2026-08-16 rule: default is DIRECT for every unlinked line.
    // A tampered / missing / unknown value defaults to DIRECT — the
    // safer outcome (no accidental catalogue row).
    it("defaults to DIRECT for missing input", () => {
        expect(parseReceiveMode(undefined)).toBe("DIRECT");
        expect(parseReceiveMode(null)).toBe("DIRECT");
        expect(parseReceiveMode("")).toBe("DIRECT");
    });

    it("defaults to DIRECT for unknown values (never spawns catalogue by accident)", () => {
        expect(parseReceiveMode("stock")).toBe("DIRECT"); // lowercase — not the wire value
        expect(parseReceiveMode("something-else")).toBe("DIRECT");
        expect(parseReceiveMode(42)).toBe("DIRECT");
    });

    it("accepts explicit STOCK only when it matches exactly", () => {
        expect(parseReceiveMode("STOCK")).toBe("STOCK");
    });

    it("accepts explicit DIRECT", () => {
        expect(parseReceiveMode("DIRECT")).toBe("DIRECT");
    });

    it("DEFAULT_MODE_FOR_UNLINKED is DIRECT — the safe default constant", () => {
        expect(DEFAULT_MODE_FOR_UNLINKED).toBe("DIRECT");
    });
});

describe("shouldUpdateEstimateCost", () => {
    // Rule: update the source EstimateLine.unitCost ONLY when the
    // estimate hasn't been invoiced yet AND the received cost
    // differs. Post-invoice, the invoice snapshot is authoritative.

    it("never updates when an invoice already exists (post-invoice snapshot is frozen)", () => {
        // Even a big cost difference doesn't move the estimate — the
        // invoice has already frozen a value; changing the estimate
        // now would leave estimate + invoice out of sync forever.
        expect(
            shouldUpdateEstimateCost({
                invoiceExists: true,
                currentUnitCost: 100,
                receivedUnitCost: 250,
            }),
        ).toBe(false);
    });

    it("updates when pre-invoice and cost differs", () => {
        expect(
            shouldUpdateEstimateCost({
                invoiceExists: false,
                currentUnitCost: 200,
                receivedUnitCost: 210,
            }),
        ).toBe(true);
    });

    it("does not update when pre-invoice but cost is identical (avoids UPDATE churn)", () => {
        expect(
            shouldUpdateEstimateCost({
                invoiceExists: false,
                currentUnitCost: 200,
                receivedUnitCost: 200,
            }),
        ).toBe(false);
    });

    it("cent-level equality — no update when values agree to 2dp", () => {
        // A round-trip through Prisma.Decimal → Number may introduce
        // trailing-decimal noise; the comparison rounds to 2dp so a
        // 200 vs 200.001 pair does not fire a write.
        expect(
            shouldUpdateEstimateCost({
                invoiceExists: false,
                currentUnitCost: 200,
                receivedUnitCost: 200.001,
            }),
        ).toBe(false);
    });

    it("updates when the estimate line had no cost previously (currentUnitCost=null)", () => {
        // Advisor typed the line but never filled cost — the receipt
        // gives us the first real number. Always capture it.
        expect(
            shouldUpdateEstimateCost({
                invoiceExists: false,
                currentUnitCost: null,
                receivedUnitCost: 175.5,
            }),
        ).toBe(true);
    });

    it("refuses a negative received cost defensively", () => {
        // parseMoney should catch this upstream, but pin the helper's
        // behaviour so a corrupt input can't silently overwrite a
        // real cost with -1.
        expect(
            shouldUpdateEstimateCost({
                invoiceExists: false,
                currentUnitCost: 100,
                receivedUnitCost: -1,
            }),
        ).toBe(false);
    });
});

describe("compareReceiptToInvoice", () => {
    // AR 2026-08-16 rewrite: three-way outcome (reconciled / mismatch
    // / unlinkable). NEVER used to suppress margin — only to render a
    // warning line on the profit card. See docs/direct-fit-receive-spec.md.

    it("reconciled when source line's unitCost matches receipt cost + invoice exists", () => {
        expect(
            compareReceiptToInvoice({
                receivedUnitCost: 250,
                qty: 1,
                sourceEstimateLine: {
                    unitCost: 250,
                    estimateHasInvoice: true,
                },
            }),
        ).toEqual({ status: "reconciled", totalDelta: null });
    });

    it("mismatch with positive delta when shop paid MORE than invoiced (invoice understates cost)", () => {
        expect(
            compareReceiptToInvoice({
                receivedUnitCost: 260,
                qty: 2,
                sourceEstimateLine: {
                    unitCost: 250,
                    estimateHasInvoice: true,
                },
            }),
        ).toEqual({ status: "mismatch", totalDelta: 20 }); // (260 - 250) × 2
    });

    it("mismatch with negative delta when shop paid LESS than invoiced (invoice overstates cost)", () => {
        expect(
            compareReceiptToInvoice({
                receivedUnitCost: 240,
                qty: 3,
                sourceEstimateLine: {
                    unitCost: 250,
                    estimateHasInvoice: true,
                },
            }),
        ).toEqual({ status: "mismatch", totalDelta: -30 }); // (240 - 250) × 3
    });

    it("unlinkable when the PO line has no source estimate line (manual-PO path)", () => {
        expect(
            compareReceiptToInvoice({
                receivedUnitCost: 250,
                qty: 1,
                sourceEstimateLine: null,
            }),
        ).toEqual({ status: "unlinkable", totalDelta: null });
    });

    it("unlinkable when the source estimate has no invoice yet", () => {
        // Nothing frozen to compare against.
        expect(
            compareReceiptToInvoice({
                receivedUnitCost: 250,
                qty: 1,
                sourceEstimateLine: {
                    unitCost: 250,
                    estimateHasInvoice: false,
                },
            }),
        ).toEqual({ status: "unlinkable", totalDelta: null });
    });

    it("unlinkable when source estimate line has null unitCost (can't compute delta)", () => {
        expect(
            compareReceiptToInvoice({
                receivedUnitCost: 250,
                qty: 1,
                sourceEstimateLine: {
                    unitCost: null,
                    estimateHasInvoice: true,
                },
            }),
        ).toEqual({ status: "unlinkable", totalDelta: null });
    });

    it("cent-level equality — 250 vs 250.001 rounds to equal → reconciled", () => {
        expect(
            compareReceiptToInvoice({
                receivedUnitCost: 250.001,
                qty: 1,
                sourceEstimateLine: {
                    unitCost: 250,
                    estimateHasInvoice: true,
                },
            }),
        ).toEqual({ status: "reconciled", totalDelta: null });
    });
});
