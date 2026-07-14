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
            "/owner/hours",
            "/owner/suppliers",
            "/owner/purchasing",
            "/owner/billing",
            "/owner/ledger",
            "/owner/whatsapp",
        ],
        ADVISOR: [
            "/advisor",
            "/advisor/estimates",
            "/advisor/chats",
            "/advisor/parts",
            "/advisor/bookings",
            "/advisor/vehicles",
            "/advisor/reminders",
            "/advisor/whatsapp",
        ],
        TECH: ["/technician"],
        CASHIER: ["/cashier", "/cashier/whatsapp"],
        MASTER: [
            "/advisor",
            "/advisor/jobs/new",
            "/technician",
            "/advisor/estimates",
            "/cashier",
            "/advisor/vehicles",
            "/advisor/bookings",
            "/advisor/parts",
            "/advisor/reminders",
            "/advisor/chats",
            "/owner/hours",
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
