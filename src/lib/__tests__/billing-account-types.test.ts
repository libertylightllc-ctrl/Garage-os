/**
 * E1a — pin that every account in ACCOUNTS has a matching row in
 * ACCOUNT_TYPES. Prevents the "added an account, forgot to classify
 * it, E5's trial balance silently drops it" class of bug. Cheap
 * belt-and-braces against a new expense (or asset, or whatever) landing
 * without its TB section assignment.
 */
import { describe, it, expect } from "vitest";
import { ACCOUNTS, ACCOUNT_TYPES } from "@/lib/billing";

describe("ACCOUNT_TYPES exhaustiveness", () => {
    it("every ACCOUNTS entry has a matching ACCOUNT_TYPES row", () => {
        const declared = Object.values(ACCOUNTS);
        const classified = new Set(Object.keys(ACCOUNT_TYPES));
        const missing = declared.filter((name) => !classified.has(name));
        expect(missing, `unclassified accounts: ${missing.join(", ")}`).toEqual([]);
    });

    it("no ACCOUNT_TYPES row without a matching ACCOUNTS entry (no dangling classifications)", () => {
        const declared = new Set<string>(Object.values(ACCOUNTS));
        const classified = Object.keys(ACCOUNT_TYPES);
        const orphaned = classified.filter((name) => !declared.has(name));
        expect(orphaned, `classifications with no matching ACCOUNTS constant: ${orphaned.join(", ")}`).toEqual([]);
    });

    it("all 11 EXP_* accounts classify as EXPENSE (plus pre-existing COGS)", () => {
        const expenseAccounts = Object.entries(ACCOUNTS)
            .filter(([key]) => key.startsWith("EXP_") || key === "COGS")
            .map(([, name]) => name);
        for (const name of expenseAccounts) {
            expect(ACCOUNT_TYPES[name], `${name} should be EXPENSE`).toBe("EXPENSE");
        }
    });
});
