import { describe, it, expect } from "vitest";
import {
    canEditEstimate,
    canEditInvoice,
    canSendEstimate,
    canSeeMargin,
} from "@/lib/permissions";

// Full role matrix pin. A silent widen (adding CASHIER to
// MARGIN_VIEW_ROLES) or narrow (removing ADVISOR) fires here in bright
// red. Every existing helper is co-pinned too so this file is the
// one-stop check for "who can do what" at review time.

const ROLES = ["OWNER", "ADVISOR", "TECH", "CASHIER", "MASTER"] as const;

describe("canSeeMargin — advisor + owner + master only (AR 2026-08-12)", () => {
    it.each(ROLES)("%s", (role) => {
        const expected = role === "OWNER" || role === "ADVISOR" || role === "MASTER";
        expect(canSeeMargin(role)).toBe(expected);
    });

    it("null / undefined → false (unauthenticated fallthrough)", () => {
        expect(canSeeMargin(null)).toBe(false);
        expect(canSeeMargin(undefined)).toBe(false);
        expect(canSeeMargin("")).toBe(false);
    });

    it("garbage role string → false (defensive)", () => {
        expect(canSeeMargin("HACKER")).toBe(false);
        expect(canSeeMargin("owner")).toBe(false); // case-sensitive
    });
});

describe("existing role helpers — pin the current shape", () => {
    it("canEditEstimate — advisor + owner + master, NOT cashier or tech", () => {
        expect(canEditEstimate("ADVISOR")).toBe(true);
        expect(canEditEstimate("OWNER")).toBe(true);
        expect(canEditEstimate("MASTER")).toBe(true);
        expect(canEditEstimate("CASHIER")).toBe(false);
        expect(canEditEstimate("TECH")).toBe(false);
    });
    it("canEditInvoice — cashier + owner + master, NOT advisor or tech", () => {
        expect(canEditInvoice("CASHIER")).toBe(true);
        expect(canEditInvoice("OWNER")).toBe(true);
        expect(canEditInvoice("MASTER")).toBe(true);
        expect(canEditInvoice("ADVISOR")).toBe(false);
        expect(canEditInvoice("TECH")).toBe(false);
    });
    it("canSendEstimate — advisor + cashier + owner + master, NOT tech", () => {
        expect(canSendEstimate("ADVISOR")).toBe(true);
        expect(canSendEstimate("CASHIER")).toBe(true);
        expect(canSendEstimate("OWNER")).toBe(true);
        expect(canSendEstimate("MASTER")).toBe(true);
        expect(canSendEstimate("TECH")).toBe(false);
    });
});
