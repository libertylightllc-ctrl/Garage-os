import { describe, it, expect } from "vitest";
import { NAV, allNavItems } from "@/config/nav";

/**
 * These tests lock the new NAV data structure against accidental drift
 * — every role must have a non-empty primary set (a nav with no
 * primary tabs is broken by design), and the union of primary +
 * overflow must equal the historic set of routes each role reached
 * through the legacy AppNav horizontal strip.
 */
describe("NAV config", () => {
    it("every role has at least one primary item", () => {
        for (const role of Object.keys(NAV) as Array<keyof typeof NAV>) {
            expect(NAV[role].primary.length).toBeGreaterThan(0);
        }
    });

    it("no duplicate keys within a role", () => {
        for (const role of Object.keys(NAV) as Array<keyof typeof NAV>) {
            const items = allNavItems(role);
            const keys = items.map((i) => i.key);
            expect(new Set(keys).size).toBe(keys.length);
        }
    });

    it("no duplicate hrefs within a role", () => {
        for (const role of Object.keys(NAV) as Array<keyof typeof NAV>) {
            const items = allNavItems(role);
            const hrefs = items.map((i) => i.href);
            expect(new Set(hrefs).size).toBe(hrefs.length);
        }
    });

    // Locks the exact route set per role — this must match the pages
    // the legacy AppNav reached, so migrating to AppShell doesn't
    // silently drop a tab. Update this list only when a route is
    // intentionally added or removed.
    const EXPECTED_ROUTES: Record<keyof typeof NAV, string[]> = {
        OWNER: [
            "/owner",
            "/advisor",
            "/advisor/jobs/new",
            "/owner/inventory",
            "/owner/analytics",
            "/owner/branches",
            "/owner/bays",
            "/owner/staff",
            // Customers list — added 2026-08-25 Batch B. Present in
            // OWNER, ADVISOR, CASHIER, and MASTER arrays. Landing
            // for the printable customer-statement lookup.
            "/advisor/customers",
            "/owner/hours",
            "/owner/suppliers",
            "/owner/purchasing",
            // Payables (AR 2026-08-30 C6) — supplier ledger, sits
            // alongside Purchasing per AR's placement call. Owner sees
            // it; MASTER sees it (operational).
            "/owner/payables",
            // Accounts (customer invoice list) — added 2026-08-12
            // after AR flagged that the /cashier page guard already
            // admits OWNER but the nav offered no way to reach it.
            "/cashier",
            "/owner/billing",
            "/owner/ledger",
            // Accounting export (COA/journal/invoices/payments/customers
            // CSV downloads) — added 2026-08-23. OWNER-only surface,
            // barred from MASTER because it contains the entire
            // financial position of the business (financial-reporting
            // bucket, per CLAUDE.md).
            "/owner/accounting",
            "/owner/whatsapp",
            // ERPNext sync (Phase 5, AR 2026-08-27) — finance surface,
            // OWNER-only.
            "/owner/erp",
        ],
        ADVISOR: [
            "/advisor",
            "/advisor/estimates",
            "/advisor/chats",
            "/advisor/parts",
            "/advisor/bookings",
            "/advisor/vehicles",
            "/advisor/customers",
            "/advisor/reminders",
            "/advisor/whatsapp",
        ],
        TECH: ["/technician"],
        CASHIER: ["/cashier", "/advisor/customers", "/cashier/whatsapp"],
        MASTER: [
            "/advisor",
            "/advisor/jobs/new",
            "/technician",
            "/advisor/estimates",
            "/cashier",
            "/advisor/vehicles",
            "/advisor/customers",
            "/advisor/bookings",
            "/advisor/parts",
            "/advisor/reminders",
            "/advisor/chats",
            "/owner/bays",
            "/owner/suppliers",
            "/owner/purchasing",
            "/owner/inventory",
            "/owner/hours",
            "/owner/payables",
            "/advisor/whatsapp",
        ],
    };

    it.each(Object.keys(NAV) as Array<keyof typeof NAV>)(
        "%s reaches the expected route set",
        (role) => {
            const got = allNavItems(role)
                .map((i) => i.href)
                .sort();
            const want = [...EXPECTED_ROUTES[role]].sort();
            expect(got).toEqual(want);
        },
    );

    it("primary tab count is reasonable for a mobile bottom bar", () => {
        // 1-5 primary items keeps the bottom bar visually clean and
        // gives each tab a ~64px slot on a 375px viewport.
        for (const role of Object.keys(NAV) as Array<keyof typeof NAV>) {
            expect(NAV[role].primary.length).toBeGreaterThanOrEqual(1);
            expect(NAV[role].primary.length).toBeLessThanOrEqual(5);
        }
    });
});
