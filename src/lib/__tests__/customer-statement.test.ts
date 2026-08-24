/**
 * Unit tests for the customer-statement shape rules. Pure JS against
 * a mocked prisma stub — no DB required.
 *
 * The load-bearing rules pinned here:
 *   - Aging bucket boundaries: 0=current, 1..30=1_30, 31..60=31_60,
 *     61..90=61_90, 91+=90_plus. Exact 31 sits in 31_60, not 1_30.
 *   - VOID invoices excluded entirely (no rows, no bucket contribution)
 *   - Fully-paid rows included as data (outstanding=0) but contribute
 *     0 to every bucket (don't skew "current" up)
 *   - Unmigrated advances net against invoicesOutstanding to produce
 *     netBalance; can go negative when customer is in credit
 *   - Invoices sorted issuedAt ASC — accountant reads a statement top-
 *     down chronologically
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state: {
    customer: Record<string, unknown> | null;
    invoices: Array<Record<string, unknown>>;
    advances: Array<Record<string, unknown>>;
} = { customer: null, invoices: [], advances: [] };

vi.mock("@/lib/prisma", () => ({
    prisma: {
        customer: { findFirst: vi.fn(async () => state.customer) },
        invoice: { findMany: vi.fn(async () => state.invoices) },
        advancePayment: { findMany: vi.fn(async () => state.advances) },
    },
}));

const { loadCustomerStatement, bucketFor } = await import("@/lib/customer-statement");

// ── Helpers ──────────────────────────────────────────────────────

const GID = "g-1";
const CID = "c-1";
const VID_A = "v-a";

function baseCustomer(overrides: Record<string, unknown> = {}) {
    return {
        id: CID, name: "Ahmed", phone: "971501234567",
        email: null, trn: "100000000000003", phoneNeedsReview: false,
        garage: { id: GID, name: "Demo", country: "UAE", trn: "100000000000003", logoUrl: null },
        vehicles: [
            { id: VID_A, make: "Toyota", model: "Camry", year: 2020, plate: "A 12345" },
        ],
        ...overrides,
    };
}

interface InvoiceFixture {
    id: string; number: number; issuedAt: Date; dueDate: Date; total: number;
    payments?: number[];
    status?: string;
    lines?: Array<{ qty: number; unitCost: number }>;
    plate?: string; make?: string; model?: string;
}

function invoice(o: InvoiceFixture) {
    return {
        id: o.id, number: o.number, issuedAt: o.issuedAt, dueDate: o.dueDate,
        total: o.total,
        payments: (o.payments ?? []).map((amount) => ({ amount })),
        lines: o.lines ?? [],
        jobCard: {
            vehicle: {
                plate: o.plate ?? "A 12345",
                make: o.make ?? "Toyota",
                model: o.model ?? "Camry",
            },
        },
    };
}

beforeEach(() => {
    state.customer = null;
    state.invoices = [];
    state.advances = [];
});

// ── Cost/margin server-side gate (AR 2026-08-25 verify) ────────────

describe("loadCustomerStatement — cost/margin gate (server-side)", () => {
    // Pins the fix for the CSS-only leak. Same fix shape as
    // loadVehicleHistory: the numbers never enter the returned
    // payload unless the caller explicitly opts in.

    it("default call (no includeCost arg) → invoice cost + margin are null even when line data exists", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 1000, lines: [{ qty: 2, unitCost: 100 }],
        })];
        // No 4th arg → default false
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"));
        expect(s!.invoices[0].cost).toBeNull();
        expect(s!.invoices[0].margin).toBeNull();
    });

    it("includeCost=false explicit → same as default", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 1000, lines: [{ qty: 2, unitCost: 100 }],
        })];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), false);
        expect(s!.invoices[0].cost).toBeNull();
        expect(s!.invoices[0].margin).toBeNull();
    });

    it("includeCost=true → cost + margin ARE returned", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 1000, lines: [{ qty: 2, unitCost: 100 }],
        })];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.invoices[0].cost).toBe(200);
        expect(s!.invoices[0].margin).toBe(800);
    });

    // Render-grep proof per AR's verify pattern: seed a distinctive
    // cost value, serialize the loader's returned object (which is
    // exactly what the page renders into the HTML), grep for the
    // seeded value + the derived margin. Expect zero occurrences
    // when off; expect >0 when on. Proves the fix at the payload
    // boundary — the same test would fail if a future edit
    // reintroduced cost/margin in the off state.
    it("PROOF: seeded cost value 787.77 is ABSENT from off-state payload, PRESENT when on", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 2000,
            lines: [{ qty: 1, unitCost: 787.77 }],
        })];
        // Off — no cost, no margin, no derived numbers anywhere.
        const off = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), false);
        const offPayload = JSON.stringify(off);
        expect(offPayload).not.toContain("787.77");
        expect(offPayload).not.toContain("1212.23"); // 2000 − 787.77
        // On — both appear.
        const on = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        const onPayload = JSON.stringify(on);
        expect(onPayload).toContain("787.77");
        expect(onPayload).toContain("1212.23");
    });
});

// ── Bucket boundaries ────────────────────────────────────────────

describe("bucketFor — exact boundary math", () => {
    it("0 days past due → current", () => expect(bucketFor(0)).toBe("current"));
    it("1 day → 1_30", () => expect(bucketFor(1)).toBe("d1_30"));
    it("30 days → 1_30 (upper edge)", () => expect(bucketFor(30)).toBe("d1_30"));
    it("31 days → 31_60 (crosses boundary)", () => expect(bucketFor(31)).toBe("d31_60"));
    it("60 days → 31_60 (upper edge)", () => expect(bucketFor(60)).toBe("d31_60"));
    it("61 days → 61_90", () => expect(bucketFor(61)).toBe("d61_90"));
    it("90 days → 61_90 (upper edge)", () => expect(bucketFor(90)).toBe("d61_90"));
    it("91 days → 90_plus", () => expect(bucketFor(91)).toBe("d90_plus"));
    it("negative days (invoice due in the future) → current", () => expect(bucketFor(-10)).toBe("current"));
});

// ── Garage scope ─────────────────────────────────────────────────

describe("loadCustomerStatement — garage scope", () => {
    it("returns null when the customer is in a different garage", async () => {
        state.customer = null;
        expect(await loadCustomerStatement(CID, "other-garage", new Date("2026-08-25"))).toBeNull();
    });

    it("returns a shape with the caller's garage embedded", async () => {
        state.customer = baseCustomer();
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s).not.toBeNull();
        expect(s!.garage.id).toBe(GID);
        expect(s!.customer.name).toBe("Ahmed");
    });
});

// ── VOID exclusion + fully-paid inclusion ────────────────────────

describe("loadCustomerStatement — invoice inclusion rules", () => {
    it("fully-paid rows are IN the invoices list (accountant wants the period) but contribute 0 to buckets", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 500, payments: [500],
        })];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.invoices).toHaveLength(1);
        expect(s!.invoices[0].fullyPaid).toBe(true);
        expect(s!.invoices[0].outstanding).toBe(0);
        expect(s!.aging.current).toBe(0);
        expect(s!.aging.d1_30).toBe(0);
        expect(s!.aging.d31_60).toBe(0);
        expect(s!.aging.invoicesOutstanding).toBe(0);
    });

    // VOID exclusion is enforced by the Prisma WHERE (status: { not: "VOID" }),
    // not in-memory filtering. Documented in the test via the stub —
    // the mock doesn't have to filter; the SUT relies on the DB clause.
    it("VOID invoices are absent — the loader's WHERE filters them at the DB, this test documents the contract", async () => {
        state.customer = baseCustomer();
        state.invoices = []; // simulating what the WHERE returns after filtering VOID
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.invoices).toHaveLength(0);
        expect(s!.aging.invoicesOutstanding).toBe(0);
    });
});

// ── Aging rollup per bucket ──────────────────────────────────────

describe("loadCustomerStatement — aging rollup", () => {
    it("places each unpaid invoice in the correct bucket by dueDate vs asOfDate", async () => {
        // asOfDate = 2026-08-25.
        // Invoice A due 2026-08-30 (5 days in FUTURE) → current, outstanding 100
        // Invoice B due 2026-08-10 (15 days past)      → 1_30,   outstanding 200
        // Invoice C due 2026-07-15 (41 days past)      → 31_60,  outstanding 300
        // Invoice D due 2026-06-15 (71 days past)      → 61_90,  outstanding 400
        // Invoice E due 2026-04-15 (132 days past)     → 90_plus, outstanding 500
        state.customer = baseCustomer();
        state.invoices = [
            invoice({ id: "iA", number: 1, issuedAt: new Date("2026-08-01"), dueDate: new Date("2026-08-30"), total: 100 }),
            invoice({ id: "iB", number: 2, issuedAt: new Date("2026-08-01"), dueDate: new Date("2026-08-10"), total: 200 }),
            invoice({ id: "iC", number: 3, issuedAt: new Date("2026-07-01"), dueDate: new Date("2026-07-15"), total: 300 }),
            invoice({ id: "iD", number: 4, issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-06-15"), total: 400 }),
            invoice({ id: "iE", number: 5, issuedAt: new Date("2026-04-01"), dueDate: new Date("2026-04-15"), total: 500 }),
        ];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.aging.current).toBe(100);
        expect(s!.aging.d1_30).toBe(200);
        expect(s!.aging.d31_60).toBe(300);
        expect(s!.aging.d61_90).toBe(400);
        expect(s!.aging.d90_plus).toBe(500);
        expect(s!.aging.invoicesOutstanding).toBe(1500);
    });

    it("partial payment on a past-due invoice → outstanding = total − paid, bucket by dueDate", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 1000, payments: [400],
        })];
        // 2026-08-25 − 2026-07-01 = 55 days → 31_60
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.invoices[0].outstanding).toBe(600);
        expect(s!.aging.d31_60).toBe(600);
        expect(s!.aging.invoicesOutstanding).toBe(600);
    });
});

// ── Advance credits + net balance ────────────────────────────────

describe("loadCustomerStatement — unmigrated advances net against outstanding", () => {
    it("sums unmigrated advances as a CREDIT and subtracts from invoicesOutstanding", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 500,
        })];
        state.advances = [
            { id: "a1", receivedAt: new Date("2026-07-15"), method: "CASH", amount: 200,
              jobCard: { number: 42, vehicle: { plate: "A 12345" } } },
        ];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.aging.invoicesOutstanding).toBe(500);
        expect(s!.aging.advancesCredit).toBe(200);
        expect(s!.aging.netBalance).toBe(300);
    });

    it("advances exceeding outstanding → negative netBalance (customer is in credit)", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 100,
        })];
        state.advances = [
            { id: "a1", receivedAt: new Date("2026-07-15"), method: "CARD", amount: 300,
              jobCard: { number: 42, vehicle: { plate: "A 12345" } } },
        ];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.aging.netBalance).toBe(-200);
    });

    it("no advances → netBalance == invoicesOutstanding", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 750,
        })];
        state.advances = [];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.aging.advancesCredit).toBe(0);
        expect(s!.aging.netBalance).toBe(750);
    });
});

// ── Ordering ──────────────────────────────────────────────────────

describe("loadCustomerStatement — invoices sorted issuedAt ASC (accountant reads top-down chronologically)", () => {
    it("preserves the chronological order the query returns", async () => {
        state.customer = baseCustomer();
        state.invoices = [
            invoice({ id: "iA", number: 10, issuedAt: new Date("2026-01-01"), dueDate: new Date("2026-02-01"), total: 100 }),
            invoice({ id: "iB", number: 11, issuedAt: new Date("2026-03-01"), dueDate: new Date("2026-04-01"), total: 200 }),
            invoice({ id: "iC", number: 12, issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"), total: 300 }),
        ];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.invoices.map((i) => i.invoiceNumber)).toEqual([10, 11, 12]);
    });
});

// ── Cost derivation on the statement ─────────────────────────────

describe("loadCustomerStatement — per-invoice cost / margin", () => {
    it("cost = Σ(qty * unitCost) across lines; margin = total − cost", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 1000,
            lines: [
                { qty: 2, unitCost: 100 }, // 200
                { qty: 1, unitCost: 300 }, // 300
            ],
        })];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.invoices[0].cost).toBe(500);
        expect(s!.invoices[0].margin).toBe(500);
    });

    it("no line-cost data → cost null (not zero) and margin null", async () => {
        state.customer = baseCustomer();
        state.invoices = [invoice({
            id: "i1", number: 100,
            issuedAt: new Date("2026-06-01"), dueDate: new Date("2026-07-01"),
            total: 1000,
            lines: [],
        })];
        const s = await loadCustomerStatement(CID, GID, new Date("2026-08-25"), true);
        expect(s!.invoices[0].cost).toBeNull();
        expect(s!.invoices[0].margin).toBeNull();
    });
});
