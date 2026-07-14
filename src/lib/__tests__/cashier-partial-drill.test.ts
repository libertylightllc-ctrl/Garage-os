/**
 * Regression: the cashier "Partially Paid" counter drill-down used to
 * filter rows by `state === "PARTIAL"`, which excluded any invoice
 * that had a partial payment AND was also past its due date (state
 * "OVERDUE"). The counter counted them via `isPartiallyPaid()`
 * (date-independent), so a shop with e.g. 5 partial-and-overdue
 * invoices would see "Partially Paid: 5" up top but "No unpaid
 * invoices — everything cleared" in the list below. Cashier couldn't
 * chase the missing balance.
 *
 * Fix: the list filter now uses `isPartiallyPaid(total, paid)` so it
 * matches the counter's definition exactly.
 *
 * Pure unit test — no DB, no auth — over the billing.ts predicates.
 */
import { describe, it, expect } from "vitest";
import { arState, isPartiallyPaid } from "@/lib/billing";

const past = new Date("2026-01-01");
const now = new Date("2026-07-15");

describe("cashier Partially Paid drill-down predicate", () => {
    it("PARTIAL-before-due invoice qualifies", () => {
        const future = new Date("2026-12-31");
        const state = arState(100, 40, future, now);
        expect(state).toBe("PARTIAL");
        expect(isPartiallyPaid(100, 40)).toBe(true);
    });

    it("OVERDUE-with-partial-payment invoice qualifies (the regression case)", () => {
        const state = arState(100, 40, past, now);
        expect(state).toBe("OVERDUE"); // date wins in arState
        expect(isPartiallyPaid(100, 40)).toBe(true); // but this predicate catches it
    });

    it("OVERDUE-with-zero-payment invoice does NOT qualify", () => {
        const state = arState(100, 0, past, now);
        expect(state).toBe("OVERDUE");
        expect(isPartiallyPaid(100, 0)).toBe(false);
    });

    it("DUE (no payment, before due) does NOT qualify", () => {
        const future = new Date("2026-12-31");
        const state = arState(100, 0, future, now);
        expect(state).toBe("DUE");
        expect(isPartiallyPaid(100, 0)).toBe(false);
    });

    it("PAID (fully paid) does NOT qualify", () => {
        const state = arState(100, 100, past, now);
        expect(state).toBe("PAID");
        expect(isPartiallyPaid(100, 100)).toBe(false);
    });

    it("counter and list agree on the mixed pilot-shop scenario", () => {
        // 5 rows: 2 straight PARTIAL, 3 OVERDUE-with-partial-payment.
        // Old list filter would show 2; counter says 5. Fix aligns them.
        const rows = [
            { total: 100, paid: 40, dueDate: new Date("2026-12-31") }, // PARTIAL
            { total: 200, paid: 50, dueDate: new Date("2026-12-31") }, // PARTIAL
            { total: 300, paid: 100, dueDate: past }, // OVERDUE + partial
            { total: 150, paid: 30, dueDate: past }, // OVERDUE + partial
            { total: 400, paid: 200, dueDate: past }, // OVERDUE + partial
        ];
        const counterMatches = rows.filter((r) => isPartiallyPaid(r.total, r.paid)).length;
        const oldListMatches = rows.filter(
            (r) => arState(r.total, r.paid, r.dueDate, now) === "PARTIAL",
        ).length;
        const newListMatches = rows.filter((r) => isPartiallyPaid(r.total, r.paid)).length;

        expect(counterMatches).toBe(5);
        expect(oldListMatches).toBe(2); // the broken behaviour
        expect(newListMatches).toBe(5); // the fix
    });
});
