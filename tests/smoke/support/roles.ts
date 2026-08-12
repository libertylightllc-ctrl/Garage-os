/**
 * Demo-user table — pinned to prisma/seed.ts.
 *
 * The staging DB is seeded with these five accounts (owner@demo.garage
 * through master@demo.garage), all with password "password". Every
 * smoke spec picks its role from this list and loads the matching
 * .auth/<role>.json storage state written by global-setup.
 *
 * The `nav` field lists every route the role's nav config surfaces
 * (mirror of src/config/nav.ts + the pinned test at
 * src/config/__tests__/nav.test.ts). Role page-load specs iterate
 * over it. When the nav config changes, add the route here too —
 * the smoke suite is the "what a human actually sees" layer on top
 * of the nav-config pin.
 */

export type SmokeRole = "owner" | "advisor" | "tech" | "cashier" | "master";

export interface SmokeUser {
    role: SmokeRole;
    email: string;
    password: string;
    nav: string[];
}

export const SMOKE_USERS: readonly SmokeUser[] = [
    {
        role: "owner",
        email: "owner@demo.garage",
        password: "password",
        nav: [
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
            "/cashier",
            "/owner/billing",
            "/owner/ledger",
            "/owner/whatsapp",
        ],
    },
    {
        role: "advisor",
        email: "advisor@demo.garage",
        password: "password",
        nav: [
            "/advisor",
            "/advisor/estimates",
            "/advisor/chats",
            "/advisor/parts",
            "/advisor/bookings",
            "/advisor/vehicles",
            "/advisor/reminders",
            "/advisor/whatsapp",
        ],
    },
    {
        role: "tech",
        email: "tech@demo.garage",
        password: "password",
        nav: ["/technician"],
    },
    {
        role: "cashier",
        email: "cashier@demo.garage",
        password: "password",
        nav: ["/cashier", "/cashier/whatsapp"],
    },
    {
        role: "master",
        email: "master@demo.garage",
        password: "password",
        nav: [
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
            "/owner/bays",
            "/owner/suppliers",
            "/owner/purchasing",
            "/owner/inventory",
            "/owner/hours",
            "/advisor/whatsapp",
        ],
    },
];

export function storageStatePath(role: SmokeRole): string {
    return `.auth/${role}.json`;
}
