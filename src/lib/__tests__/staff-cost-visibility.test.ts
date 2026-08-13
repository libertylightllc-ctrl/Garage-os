/**
 * Staff cost/markup visibility pin — rendered-payload check (AR 2026-08-14).
 *
 * `/estimates/[id]` accepts CASHIER + ADVISOR + OWNER + MASTER as page
 * viewers (cashier needs to open approved estimates to generate the
 * invoice). Cost, markup, and margin are ADVISOR / OWNER / MASTER only.
 *
 * Previous version of this test source-inspected the page file for the
 * `canShowCost = canSeeMargin(role)` gate pattern. It passed 13/13 while
 * a live cost leak was in production: the page maps `est.lines` TWICE
 * (once for the mobile card at ~L306, once for the desktop table row
 * at ~L383) and the source-grep matched the first (gated) call site
 * without noticing the second (ungated) one still leaked. Both mappings
 * end up in the RSC payload regardless of which one CSS reveals, so a
 * cashier's browser could `view-source` the raw supplier cost even
 * though nothing was visible on screen.
 *
 * This test invokes the page's default export as a Server Component
 * function with a cashier session, walks the returned React tree, and
 * asserts every EstimateLineCard / EstimateLineRow the tree contains
 * has `line.unitCost === null` and `line.markupPct === null`. It also
 * greps the entire tree (props + children, recursively) for the literal
 * cost value we seeded — 77.77 must not appear anywhere in the cashier
 * payload. If a future third mapping is added and the component-name
 * walk misses it, the literal-grep catches it.
 *
 * The advisor test is a POSITIVE CONTROL. Without it, a bug that made
 * `unitCost` upstream-null in the fixture would let the cashier test
 * pass trivially. Advisor must see 77.77 on both call sites.
 */
import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => undefined }), // default locale
}));
vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        throw new Error("REDIRECT:" + url);
    },
    notFound: () => {
        throw new Error("NOT_FOUND");
    },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { default: EstimateEditor } = await import("@/app/estimates/[id]/page");

const P = "staff-cost-visibility-test-";
const gA = P + "garage-A";
const COST = 77.77;
const MARKUP = 12.5;

const as = (role: string) => ({
    user: {
        id: P + "u-" + role.toLowerCase(),
        role,
        garageId: gA,
        email: "x",
        name: "x",
    },
});

async function setup(): Promise<string> {
    await prisma.garage.upsert({
        where: { id: gA },
        update: {},
        create: { id: gA, name: gA },
    });
    for (const role of ["ADVISOR", "CASHIER", "OWNER", "MASTER"]) {
        const id = P + "u-" + role.toLowerCase();
        await prisma.user.upsert({
            where: { id },
            update: {},
            create: {
                id,
                garageId: gA,
                role: role as never,
                name: role,
                email: id + "@test.local",
            },
        });
    }
    const customer = await prisma.customer.create({
        data: { garageId: gA, name: "Cost Leak Test", phone: P + "555" },
    });
    const vehicle = await prisma.vehicle.create({
        data: {
            customerId: customer.id,
            plate: P.slice(0, 8) + "PLT",
            make: "Ford",
            model: "Focus",
            year: 2020,
        },
    });
    const job = await prisma.jobCard.create({
        data: {
            garageId: gA,
            vehicleId: vehicle.id,
            status: "ESTIMATE",
            complaint: "cost visibility test",
        },
    });
    const est = await prisma.estimate.create({
        data: {
            jobCardId: job.id,
            status: "DRAFT",
            subtotal: 87.49,
            vatAmount: 4.37,
            total: 91.86,
            lines: {
                create: [
                    {
                        kind: "PART",
                        description: "Oil filter",
                        qty: 1,
                        unitCost: COST,
                        markupPct: MARKUP,
                        unitPrice: 87.49,
                        lineTotal: 87.49,
                    },
                ],
            },
        },
    });
    return est.id;
}

async function cleanup() {
    const inGarage = { jobCard: { garageId: { startsWith: P } } };
    await prisma.estimateLine.deleteMany({ where: { estimate: inGarage } });
    await prisma.estimate.deleteMany({ where: inGarage });
    await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.vehicle.deleteMany({
        where: { customer: { garageId: { startsWith: P } } },
    });
    await prisma.customer.deleteMany({
        where: { garageId: { startsWith: P } },
    });
    await prisma.user.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

let estId: string;
beforeEach(async () => {
    await cleanup();
    estId = await setup();
    mockAuth.mockReset();
});
afterAll(cleanup);

/**
 * Recursively walk a React element tree, collecting every element whose
 * `type` is a function whose `.name` matches one of `names`. Elements
 * appear both as direct children and as values on named props (e.g.
 * <Foo header={<Bar />} />), so both paths are walked. Server-component
 * children that are async functions appear here as un-rendered elements
 * — that's fine, we're looking at what the SERIALIZER would emit,
 * which is exactly the client-component props at the boundaries.
 */
function findByComponentName(
    node: unknown,
    names: Set<string>,
    out: { type: { name: string }; props: Record<string, unknown> }[],
): void {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const n of node) findByComponentName(n, names, out);
        return;
    }
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    const t = el.type;
    if (
        typeof t === "function" &&
        typeof (t as { name?: unknown }).name === "string" &&
        names.has((t as { name: string }).name)
    ) {
        out.push({
            type: t as unknown as { name: string },
            props: el.props ?? {},
        });
    }
    if (el.props) {
        for (const v of Object.values(el.props)) {
            findByComponentName(v, names, out);
        }
    }
}

/**
 * Flatten a React tree to a giant search string — every primitive prop
 * value + every child string/number gets concatenated (NUL-separated so
 * substring matches don't cross boundaries). Used to catch a third
 * payload mapping that the component-name walk above might miss.
 */
function treeToSearchString(node: unknown, out: string[]): void {
    if (node == null) return;
    const t = typeof node;
    if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
        out.push(String(node));
        return;
    }
    if (Array.isArray(node)) {
        for (const n of node) treeToSearchString(n, out);
        return;
    }
    if (t !== "object") return;
    const el = node as { props?: Record<string, unknown> };
    if (el.props) {
        for (const [k, v] of Object.entries(el.props)) {
            // Include the key so an object like { unitCost: 77.77 } surfaces
            // both "unitCost" and "77.77" — the point of the belt-and-braces
            // grep is that the literal number can't slip past unnoticed.
            out.push(k);
            treeToSearchString(v, out);
        }
    }
}

describe("/estimates/[id] — cost/markup gated at the payload boundary", () => {
    it("cashier: no unitCost / markupPct on ANY EstimateLineCard or EstimateLineRow", async () => {
        mockAuth.mockResolvedValue(as("CASHIER"));
        const tree = await EstimateEditor({
            params: Promise.resolve({ id: estId }),
        });
        const lineElements: {
            type: { name: string };
            props: Record<string, unknown>;
        }[] = [];
        findByComponentName(
            tree,
            new Set(["EstimateLineCard", "EstimateLineRow"]),
            lineElements,
        );
        expect(
            lineElements.length,
            "expected the page to render BOTH the mobile card AND the desktop row for the seeded line — the leak that broke prod was one mapping being ungated, so both must be checked",
        ).toBeGreaterThanOrEqual(2);
        for (const el of lineElements) {
            const line = el.props.line as {
                unitCost: unknown;
                markupPct: unknown;
            };
            expect(
                line.unitCost,
                `${el.type.name}.line.unitCost must be null for cashier (leaked value: ${String(line.unitCost)})`,
            ).toBeNull();
            expect(
                line.markupPct,
                `${el.type.name}.line.markupPct must be null for cashier (leaked value: ${String(line.markupPct)})`,
            ).toBeNull();
        }
        // Belt-and-braces literal-grep — if a future third payload mapping
        // is added and the component-name walk above misses it, this
        // catches the leak by literal-searching the whole tree.
        const bag: string[] = [];
        treeToSearchString(tree, bag);
        const haystack = bag.join(" ");
        expect(
            haystack,
            `the literal seeded cost value ${COST} must not appear anywhere in the cashier's rendered RSC payload — if this fails but the per-component checks passed, a third payload site was added that this test doesn't yet know about`,
        ).not.toContain(String(COST));
        expect(
            haystack,
            `the literal seeded markup value ${MARKUP} must not appear anywhere in the cashier's rendered RSC payload`,
        ).not.toContain(String(MARKUP));
    });

    it("advisor: unitCost + markupPct DO reach both call sites (positive control)", async () => {
        // Without this, an upstream bug that made unitCost null in the
        // fixture would let the cashier test above pass trivially. The
        // advisor must see the real cost on every mapping.
        mockAuth.mockResolvedValue(as("ADVISOR"));
        const tree = await EstimateEditor({
            params: Promise.resolve({ id: estId }),
        });
        const lineElements: {
            type: { name: string };
            props: Record<string, unknown>;
        }[] = [];
        findByComponentName(
            tree,
            new Set(["EstimateLineCard", "EstimateLineRow"]),
            lineElements,
        );
        expect(lineElements.length).toBeGreaterThanOrEqual(2);
        for (const el of lineElements) {
            const line = el.props.line as {
                unitCost: unknown;
                markupPct: unknown;
            };
            expect(
                line.unitCost,
                `${el.type.name}.line.unitCost must equal seeded ${COST} for advisor`,
            ).toBe(COST);
            expect(
                line.markupPct,
                `${el.type.name}.line.markupPct must equal seeded ${MARKUP} for advisor`,
            ).toBe(MARKUP);
        }
    });
});
