/**
 * Payables C6 — pin the aging math, especially:
 *   - Ages from billDate, NOT createdAt / receivedAt.
 *   - Excludes PAID and VOID bills.
 *   - Partial payment is aged on the outstanding portion only.
 *   - Bucket boundaries (0-30 / 31-60 / 61-90 / 91+) are inclusive
 *     of the lower and exclusive of the upper.
 */

import { describe, it, expect } from "vitest";
import { agingBuckets, supplierOutstanding } from "@/lib/supplier-aging";

const now = new Date("2026-09-30T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

describe("agingBuckets", () => {
    it("puts OPEN bills into the right buckets based on billDate", () => {
        const b = agingBuckets(
            [
                { billDate: daysAgo(5), total: 100, paidAmount: 0, status: "OPEN" }, // current
                { billDate: daysAgo(45), total: 200, paidAmount: 0, status: "OPEN" }, // 31-60
                { billDate: daysAgo(75), total: 300, paidAmount: 0, status: "OPEN" }, // 61-90
                { billDate: daysAgo(120), total: 400, paidAmount: 0, status: "OPEN" }, // 91+
            ],
            now,
        );
        expect(b).toEqual({
            current: 100,
            days30: 200,
            days60: 300,
            days90plus: 400,
            total: 1000,
        });
    });

    it("excludes PAID and VOID from every bucket", () => {
        const b = agingBuckets(
            [
                { billDate: daysAgo(5), total: 100, paidAmount: 100, status: "PAID" },
                { billDate: daysAgo(45), total: 200, paidAmount: 0, status: "VOID" },
                { billDate: daysAgo(75), total: 300, paidAmount: 0, status: "OPEN" },
            ],
            now,
        );
        expect(b).toEqual({
            current: 0,
            days30: 0,
            days60: 300,
            days90plus: 0,
            total: 300,
        });
    });

    it("ages the OUTSTANDING portion of PARTIALLY_PAID bills", () => {
        const b = agingBuckets(
            [
                {
                    billDate: daysAgo(45),
                    total: 500,
                    paidAmount: 300,
                    status: "PARTIALLY_PAID",
                },
            ],
            now,
        );
        expect(b.days30).toBe(200); // 500 - 300 remainder
        expect(b.total).toBe(200);
    });

    it("bucket boundary — day 30 is Current, day 31 is Days30", () => {
        const b30 = agingBuckets(
            [{ billDate: daysAgo(30), total: 100, paidAmount: 0, status: "OPEN" }],
            now,
        );
        expect(b30.current).toBe(100);
        expect(b30.days30).toBe(0);

        const b31 = agingBuckets(
            [{ billDate: daysAgo(31), total: 100, paidAmount: 0, status: "OPEN" }],
            now,
        );
        expect(b31.current).toBe(0);
        expect(b31.days30).toBe(100);
    });

    it("bill dated in the future (billDate > now) counts as Current, not negative-age", () => {
        // A supplier who dates their invoice ahead of shipment
        // shouldn't drop into an odd bucket. Floor(negative/DAY_MS)
        // < 31 → Current, which is what we want.
        const b = agingBuckets(
            [{ billDate: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000), total: 100, paidAmount: 0, status: "OPEN" }],
            now,
        );
        expect(b.current).toBe(100);
        expect(b.total).toBe(100);
    });
});

describe("supplierOutstanding", () => {
    it("sums outstanding across OPEN + PARTIALLY_PAID, ignores PAID/VOID", () => {
        const total = supplierOutstanding([
            { billDate: daysAgo(5), total: 100, paidAmount: 40, status: "PARTIALLY_PAID" },
            { billDate: daysAgo(45), total: 200, paidAmount: 0, status: "OPEN" },
            { billDate: daysAgo(75), total: 300, paidAmount: 300, status: "PAID" },
            { billDate: daysAgo(120), total: 400, paidAmount: 0, status: "VOID" },
        ]);
        expect(total).toBe(260); // 60 + 200
    });
});
