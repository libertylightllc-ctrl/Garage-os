/**
 * Unit tests for the vehicle-history shape rules. Pure-JS assertions
 * against the derivation logic exposed indirectly through the entry
 * shape — the DB read is mocked via a lightweight prisma stub so no
 * database is required.
 *
 * The tests pin the three load-bearing rules:
 *   - Revenue source precedence: invoice > APPROVED estimate > none
 *   - Cost = Σ(qty * unitCost) across the source's lines; null when
 *     no source (not zero)
 *   - Owner-at-job-time walk: JC before first transfer → previous-
 *     owner snapshot; JC at-or-after transfer → new-owner snapshot
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the prisma client used by vehicle-history.ts. Every test
// reseeds these arrays via the helper below; the mock reads them
// synchronously and returns Promise-wrapped results.

const state: {
    vehicle: Record<string, unknown> | null;
    jobs: Array<Record<string, unknown>>;
} = { vehicle: null, jobs: [] };

vi.mock("@/lib/prisma", () => ({
    prisma: {
        vehicle: {
            findFirst: vi.fn(async () => state.vehicle),
        },
        jobCard: {
            findMany: vi.fn(async () => state.jobs),
        },
    },
}));

const { loadVehicleHistory } = await import("@/lib/vehicle-history");

// ── Helpers ──────────────────────────────────────────────────────

const GID = "g-1";
const VID = "v-1";
const CID_CURRENT = "c-current";

function baseVehicle(overrides: Record<string, unknown> = {}) {
    return {
        id: VID,
        make: "Toyota", model: "Camry", year: 2020,
        plate: "A 12345", vin: null, engineSize: null, fuelType: null,
        customer: {
            id: CID_CURRENT, name: "Current Owner", phone: "971501111111",
            garage: { id: GID, name: "Demo", country: "UAE", trn: "100000000000003", logoUrl: null },
        },
        ownershipTransfers: [],
        ...overrides,
    };
}

function job(opts: {
    id: string; number: number | null; createdAt: Date;
    mileageIn?: number | null;
    complaint?: string | null;
    status?: string;
    invoice?: {
        id: string; number: number; total: number; status: string;
        payments?: Array<{ amount: number }>;
        lines?: Array<{ kind: string; description: string; qty: number; unitCost: number; lineTotal: number }>;
    } | null;
    estimate?: {
        status: string; total: number;
        lines?: Array<{ kind: string; description: string; qty: number; unitCost: number; lineTotal: number }>;
    } | null;
}) {
    return {
        id: opts.id,
        number: opts.number,
        createdAt: opts.createdAt,
        mileageIn: opts.mileageIn ?? null,
        complaint: opts.complaint ?? null,
        status: opts.status ?? "DELIVERED",
        estimates: opts.estimate ? [{ ...opts.estimate, lines: opts.estimate.lines ?? [] }] : [],
        // JobCard.invoices is plural in the schema (void+reissue). The
        // loader picks the most recent non-VOID; test fixtures wrap
        // the single invoice case into a 1-element array.
        invoices: opts.invoice
            ? [{ ...opts.invoice, payments: opts.invoice.payments ?? [], lines: opts.invoice.lines ?? [] }]
            : [],
    };
}

beforeEach(() => {
    state.vehicle = null;
    state.jobs = [];
});

// ── Root: garage scope + not-found ───────────────────────────────

describe("loadVehicleHistory — garage scope", () => {
    it("returns null when the vehicle is not in the caller's garage", async () => {
        state.vehicle = null; // simulates the WHERE customer.garageId=X missing
        expect(await loadVehicleHistory(VID, "other-garage")).toBeNull();
    });

    it("returns a shape when the vehicle IS in the garage, with the caller's garage on it", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [];
        const h = await loadVehicleHistory(VID, GID);
        expect(h).not.toBeNull();
        expect(h!.garage.id).toBe(GID);
        expect(h!.currentOwner.name).toBe("Current Owner");
    });
});

// ── Revenue source precedence ────────────────────────────────────

describe("loadVehicleHistory — revenue source per entry", () => {
    it("uses INVOICE.total when the visit is invoiced (source=invoice)", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [job({
            id: "j1", number: 1, createdAt: new Date("2026-01-01"),
            invoice: {
                id: "i1", number: 100, total: 500, status: "PAID",
                lines: [{ kind: "PART", description: "Brake pad", qty: 1, unitCost: 200, lineTotal: 300 }],
            },
            estimate: { status: "APPROVED", total: 480, lines: [] }, // shouldn't be used
        })];
        const h = await loadVehicleHistory(VID, GID);
        const e = h!.entries[0];
        expect(e.source).toBe("invoice");
        expect(e.revenue).toBe(500);
        expect(e.invoiceNumber).toBe(100);
    });

    it("uses APPROVED estimate when no invoice (source=estimate)", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [job({
            id: "j1", number: 1, createdAt: new Date("2026-01-01"),
            estimate: {
                status: "APPROVED", total: 480,
                lines: [{ kind: "LABOR", description: "Diagnosis", qty: 1, unitCost: 0, lineTotal: 200 }],
            },
        })];
        const h = await loadVehicleHistory(VID, GID);
        const e = h!.entries[0];
        expect(e.source).toBe("estimate");
        expect(e.revenue).toBe(480);
        expect(e.invoiceNumber).toBeNull();
    });

    it("DRAFT/SENT/REJECTED estimate with no invoice → source=none, revenue null", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [
            job({ id: "j1", number: 1, createdAt: new Date("2026-01-01"), estimate: { status: "DRAFT", total: 480 } }),
            job({ id: "j2", number: 2, createdAt: new Date("2026-02-01"), estimate: { status: "SENT", total: 480 } }),
            job({ id: "j3", number: 3, createdAt: new Date("2026-03-01"), estimate: { status: "REJECTED", total: 480 } }),
        ];
        const h = await loadVehicleHistory(VID, GID);
        for (const e of h!.entries) {
            expect(e.source).toBe("none");
            expect(e.revenue).toBeNull();
        }
    });
});

// ── Cost derivation ──────────────────────────────────────────────

describe("loadVehicleHistory — cost is Σ(qty * unitCost), null when no source", () => {
    it("sums qty*unitCost across all lines on the source", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [job({
            id: "j1", number: 1, createdAt: new Date("2026-01-01"),
            invoice: {
                id: "i1", number: 100, total: 1000, status: "PAID",
                lines: [
                    { kind: "PART", description: "Pads", qty: 2, unitCost: 100, lineTotal: 300 }, // 200
                    { kind: "PART", description: "Rotors", qty: 2, unitCost: 250, lineTotal: 700 }, // 500
                    { kind: "LABOR", description: "Fit", qty: 1, unitCost: 0, lineTotal: 100 }, // 0
                ],
            },
        })];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.entries[0].cost).toBe(700);
        expect(h!.entries[0].margin).toBe(300);
    });

    it("cost NULL (not zero) when there is no source at all", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [job({ id: "j1", number: 1, createdAt: new Date("2026-01-01") })];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.entries[0].cost).toBeNull();
        expect(h!.entries[0].margin).toBeNull();
    });

    it("cost 0 (not null) when source exists but every line has unitCost=0 — a real datum", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [job({
            id: "j1", number: 1, createdAt: new Date("2026-01-01"),
            invoice: {
                id: "i1", number: 100, total: 200, status: "PAID",
                lines: [{ kind: "LABOR", description: "Diag only", qty: 1, unitCost: 0, lineTotal: 200 }],
            },
        })];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.entries[0].cost).toBe(0);
        expect(h!.entries[0].margin).toBe(200);
    });
});

// ── Outstanding balance ──────────────────────────────────────────

describe("loadVehicleHistory — outstanding balance per invoice", () => {
    it("fully paid → outstanding 0", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [job({
            id: "j1", number: 1, createdAt: new Date("2026-01-01"),
            invoice: { id: "i1", number: 100, total: 500, status: "PAID", payments: [{ amount: 500 }] },
        })];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.entries[0].outstanding).toBe(0);
    });

    it("partial payment → outstanding = total − paid", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [job({
            id: "j1", number: 1, createdAt: new Date("2026-01-01"),
            invoice: { id: "i1", number: 100, total: 500, status: "SENT", payments: [{ amount: 200 }] },
        })];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.entries[0].outstanding).toBe(300);
    });

    it("estimate-only visit → outstanding null (nothing to pay yet)", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [job({
            id: "j1", number: 1, createdAt: new Date("2026-01-01"),
            estimate: { status: "APPROVED", total: 300 },
        })];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.entries[0].outstanding).toBeNull();
    });
});

// ── Owner-at-job-time walk ────────────────────────────────────────

describe("loadVehicleHistory — owner-at-job-time across transfers", () => {
    it("no transfers → every entry's ownerAtJobTime is null (current owner had it since day one)", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [
            job({ id: "j1", number: 1, createdAt: new Date("2026-01-01") }),
            job({ id: "j2", number: 2, createdAt: new Date("2026-06-01") }),
        ];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.hasChangedHands).toBe(false);
        for (const e of h!.entries) expect(e.ownerAtJobTime).toBeNull();
    });

    it("one transfer: JC before transfer → previous owner; JC at-or-after → new owner", async () => {
        state.vehicle = baseVehicle({
            ownershipTransfers: [
                {
                    transferredAt: new Date("2026-03-15"),
                    previousOwnerName: "Old Owner",
                    previousOwnerPhone: "971509999999",
                    toCustomer: { name: "New Owner", phone: "971501111111" },
                },
            ],
        });
        state.jobs = [
            job({ id: "j1", number: 1, createdAt: new Date("2026-01-01") }), // BEFORE → Old Owner
            job({ id: "j2", number: 2, createdAt: new Date("2026-03-15") }), // AT → New Owner
            job({ id: "j3", number: 3, createdAt: new Date("2026-06-01") }), // AFTER → New Owner
        ];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.hasChangedHands).toBe(true);
        expect(h!.entries[0].ownerAtJobTime?.name).toBe("Old Owner");
        expect(h!.entries[1].ownerAtJobTime?.name).toBe("New Owner");
        expect(h!.entries[2].ownerAtJobTime?.name).toBe("New Owner");
    });

    it("two transfers: JC lands under whichever transfer was most recent at that point", async () => {
        state.vehicle = baseVehicle({
            ownershipTransfers: [
                {
                    transferredAt: new Date("2026-02-01"),
                    previousOwnerName: "First Owner",
                    previousOwnerPhone: "971500000001",
                    toCustomer: { name: "Second Owner", phone: "971500000002" },
                },
                {
                    transferredAt: new Date("2026-06-01"),
                    previousOwnerName: "Second Owner",
                    previousOwnerPhone: "971500000002",
                    toCustomer: { name: "Third Owner", phone: "971500000003" },
                },
            ],
        });
        state.jobs = [
            job({ id: "j1", number: 1, createdAt: new Date("2026-01-01") }), // First
            job({ id: "j2", number: 2, createdAt: new Date("2026-03-01") }), // Second
            job({ id: "j3", number: 3, createdAt: new Date("2026-07-01") }), // Third
        ];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.entries[0].ownerAtJobTime?.name).toBe("First Owner");
        expect(h!.entries[1].ownerAtJobTime?.name).toBe("Second Owner");
        expect(h!.entries[2].ownerAtJobTime?.name).toBe("Third Owner");
    });
});

// ── Lifetime totals ──────────────────────────────────────────────

describe("loadVehicleHistory — lifetime totals across every entry", () => {
    it("sums revenue, cost, margin, outstanding across all jobs — null entries contribute 0", async () => {
        state.vehicle = baseVehicle();
        state.jobs = [
            job({
                id: "j1", number: 1, createdAt: new Date("2026-01-01"),
                invoice: {
                    id: "i1", number: 100, total: 500, status: "PAID", payments: [{ amount: 500 }],
                    lines: [{ kind: "PART", description: "x", qty: 1, unitCost: 200, lineTotal: 300 }],
                },
            }),
            job({
                id: "j2", number: 2, createdAt: new Date("2026-02-01"),
                invoice: {
                    id: "i2", number: 101, total: 300, status: "SENT", payments: [{ amount: 100 }],
                    lines: [{ kind: "PART", description: "y", qty: 1, unitCost: 100, lineTotal: 300 }],
                },
            }),
            job({ id: "j3", number: 3, createdAt: new Date("2026-03-01") }), // no source
        ];
        const h = await loadVehicleHistory(VID, GID);
        expect(h!.totals.visits).toBe(3);
        expect(h!.totals.lifetimeRevenue).toBe(800);
        expect(h!.totals.lifetimeCost).toBe(300);
        expect(h!.totals.lifetimeMargin).toBe(500);
        expect(h!.totals.outstandingBalance).toBe(200);
    });
});
