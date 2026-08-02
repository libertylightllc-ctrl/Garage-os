/**
 * Inventory 2a — tenant-isolation + permission tests for purchase orders.
 * Proves:
 *   1. createPurchaseOrderAction writes to the CALLER'S garage and only
 *      accepts a supplier from that garage.
 *   2. addPoLineAction only accepts a part from the caller's garage, only
 *      on a DRAFT, and rejects a PO from another garage.
 *   3. setPoStatusAction enforces the DRAFT→ORDERED (needs a line) and
 *      cancel rules, garage-scoped.
 *   4. Only OWNER can do any of it.
 *
 * Cleanup by garage-id prefix.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));
// The guard verifies the JWT's user id resolves to a live User row via
// prisma.user.count. This suite never seeds a User, so the real query
// returns 0 and every action redirects to /login before it can be
// tested. Force the guard to say "yes, live user" so the actual
// action-under-test runs.
vi.mock("@/lib/session-user", () => ({ sessionUserExists: async () => true }));

const {
  createPurchaseOrderAction,
  addPoLineAction,
  editPoLineAction,
  removePoLineAction,
  setPoStatusAction,
  receivePurchaseOrderAction,
  returnPurchaseOrderAction,
} = await import("@/app/actions/purchasing");

const P = "po-iso-test-";
const gA = P + "garage-A";
const gB = P + "garage-B";

function owner(garageId: string) {
  return { user: { id: P + "u", role: "OWNER", garageId, email: "x", name: "x" } };
}
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
async function call(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<string> {
  try {
    await action(fd);
    return "(no redirect)";
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("REDIRECT:")) return m.slice("REDIRECT:".length);
    throw e;
  }
}
const supplier = (garageId: string, name = "S") =>
  prisma.supplier.create({ data: { garageId, name } });
const part = (garageId: string, sku: string) =>
  prisma.part.create({ data: { garageId, sku, name: "P " + sku, cost: "5", price: "9" } });

async function cleanup() {
  await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { garageId: { startsWith: P } } } });
  await prisma.purchaseOrder.deleteMany({ where: { garageId: { startsWith: P } } });
  // Receiving writes PartMovements — clear them before their parts (FK).
  await prisma.partMovement.deleteMany({ where: { part: { garageId: { startsWith: P } } } });
  await prisma.part.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.supplier.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}
beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: gA, name: P + "A" } });
  await prisma.garage.create({ data: { id: gB, name: P + "B" } });
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createPurchaseOrderAction", { retry: 3 }, () => {
  it("creates a DRAFT PO in the caller's garage for its own supplier", async () => {
    const s = await supplier(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(createPurchaseOrderAction, form({ supplierId: s.id, reference: "Q-1" }));
    expect(to).toMatch(/^\/owner\/purchasing\/.+/);
    const pos = await prisma.purchaseOrder.findMany({ where: { garageId: gA } });
    expect(pos.length).toBe(1);
    expect(pos[0].status).toBe("DRAFT");
    expect(pos[0].reference).toBe("Q-1");
  });

  it("refuses a supplier from another garage", async () => {
    const sB = await supplier(gB);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(createPurchaseOrderAction, form({ supplierId: sB.id }));
    expect(to).toContain("error=");
    expect((await prisma.purchaseOrder.findMany({ where: { garageId: gA } })).length).toBe(0);
  });

  it("rejects a non-owner", async () => {
    const s = await supplier(gA);
    mockAuth.mockResolvedValueOnce({ user: { id: "x", role: "ADVISOR", garageId: gA, email: "x", name: "x" } });
    await expect(createPurchaseOrderAction(form({ supplierId: s.id }))).rejects.toThrow("Not authorized");
  });
});

async function draftPO(garageId: string) {
  const s = await supplier(garageId);
  return prisma.purchaseOrder.create({ data: { garageId, supplierId: s.id } });
}

describe("addPoLineAction", { retry: 3 }, () => {
  it("adds a line with the caller's own part (datalist match → linked)", async () => {
    // Layer 1 (2026-08-02): the form field is `lineText`, not `partId`.
    // The action does a case-insensitive exact-match against Part.name
    // in the caller's own garage. A typed name that matches an existing
    // Part in gA links the PO line to that Part.
    const po = await draftPO(gA);
    const p = await part(gA, "A1"); // Part.name is "P A1"
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(addPoLineAction, form({ poId: po.id, lineText: p.name, qty: "4", unitCost: "7.50" }));
    const lines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
    expect(lines.length).toBe(1);
    expect(lines[0].qty).toBe(4);
    expect(Number(lines[0].unitCost)).toBe(7.5);
    // Match linked to the caller's own Part — NOT a free-text write.
    expect(lines[0].partId).toBe(p.id);
    expect(lines[0].description).toBe(p.name);
  });

  it("typing garage B's part name from garage A → free-text line, NEVER a cross-tenant link", async () => {
    // Cross-garage guard, reshaped for Layer 1. Under the old form
    // contract this test asserted "cannot smuggle another garage's
    // partId into the write". That vector no longer exists — there's
    // no partId field. The new attack surface is name collision: an
    // owner in gA types the exact name of a Part that only exists in
    // gB. The garage-scoped findFirst in addPoLineAction returns null
    // for gA's search (Part.name lives in gB, not gA), and the write
    // falls into the FREE-TEXT branch with partId null. The typed text
    // is preserved as the line's description; nothing links across
    // tenants.
    const po = await draftPO(gA);
    const pB = await part(gB, "B1"); // Part.name is "P B1", scoped to gB
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(addPoLineAction, form({ poId: po.id, lineText: pB.name, qty: "1", unitCost: "1" }));
    const lines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
    expect(lines.length).toBe(1); // free-text write is legitimate
    expect(lines[0].partId).toBeNull(); // NEVER linked to gB's Part
    expect(lines[0].description).toBe(pB.name); // typed text preserved
    // Belt-and-braces: gB's Part row is untouched by the write from gA.
    const pBStill = await prisma.part.findUnique({ where: { id: pB.id } });
    expect(pBStill?.garageId).toBe(gB);
  });

  it("cannot add a line to another garage's PO", async () => {
    // PO ownership scoping is unchanged: `ownedPO(poId, user.garageId)`
    // still rejects a poId from another garage regardless of what the
    // line text says. Send gA's own part name to keep the lookup
    // successful — the block must come from PO ownership, not the
    // lineText lookup.
    const poB = await draftPO(gB);
    const pA = await part(gA, "A2");
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(addPoLineAction, form({ poId: poB.id, lineText: pA.name, qty: "1", unitCost: "1" }));
    expect((await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: poB.id } })).length).toBe(0);
  });

  it("rejects qty <= 0", async () => {
    const po = await draftPO(gA);
    const p = await part(gA, "A3");
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(addPoLineAction, form({ poId: po.id, lineText: p.name, qty: "0", unitCost: "1" }));
    expect(to).toContain("error=");
    expect((await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } })).length).toBe(0);
  });
});

describe("setPoStatusAction", { retry: 3 }, () => {
  it("won't mark ORDERED without any line", async () => {
    const po = await draftPO(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(setPoStatusAction, form({ poId: po.id, status: "ORDERED" }));
    expect(to).toContain("error=");
    expect((await prisma.purchaseOrder.findUnique({ where: { id: po.id } }))?.status).toBe("DRAFT");
  });

  it("marks ORDERED once a line exists, stamping orderedAt", async () => {
    const po = await draftPO(gA);
    const p = await part(gA, "A4");
    await prisma.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, partId: p.id, qty: 2, unitCost: "3" } });
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(setPoStatusAction, form({ poId: po.id, status: "ORDERED" }));
    const row = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(row?.status).toBe("ORDERED");
    expect(row?.orderedAt).not.toBeNull();
  });

  it("cancels a draft", async () => {
    const po = await draftPO(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(setPoStatusAction, form({ poId: po.id, status: "CANCELLED" }));
    expect((await prisma.purchaseOrder.findUnique({ where: { id: po.id } }))?.status).toBe("CANCELLED");
  });

  it("cannot change another garage's PO", async () => {
    const poB = await draftPO(gB);
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(setPoStatusAction, form({ poId: poB.id, status: "CANCELLED" }));
    expect((await prisma.purchaseOrder.findUnique({ where: { id: poB.id } }))?.status).toBe("DRAFT");
  });

  it("removePoLineAction removes a line on a draft (scoped)", async () => {
    const po = await draftPO(gA);
    const p = await part(gA, "A5");
    const line = await prisma.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, partId: p.id, qty: 1, unitCost: "1" } });
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(removePoLineAction, form({ poId: po.id, lineId: line.id }));
    expect((await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } })).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// editPoLineAction — qty + unitCost editing on a DRAFT line. The DRAFT-only
// guard is the invariant that protects the receiving math: qty is the cap
// for `outstanding = qty - receivedQty` in receivePurchaseOrderAction, and
// both the atomic cap-check and the RECEIVED status recompute read from
// qty. If a non-DRAFT edit slipped through, receiving would over- or
// under-book. Every non-DRAFT status is pinned individually, not just one.
// ---------------------------------------------------------------------------
describe("editPoLineAction", { retry: 3 }, () => {
  async function draftPoWithLine(garageId: string, tag: string) {
    const po = await draftPO(garageId);
    const p = await part(garageId, tag);
    const line = await prisma.purchaseOrderLine.create({
      data: { purchaseOrderId: po.id, partId: p.id, qty: 2, unitCost: "10.00" },
    });
    return { po, line };
  }

  // `expectedUpdatedAt` is required — every existing test now threads
  // the row's live `updatedAt` (ISO) through the form so the
  // stale-write guard passes on the happy path. The three concurrency
  // tests further down exercise the guard itself.
  it("edits qty + unitCost on a DRAFT line", async () => {
    const { po, line } = await draftPoWithLine(gA, "E1");
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(editPoLineAction, form({
      poId: po.id,
      lineId: line.id,
      qty: "7",
      unitCost: "12.34",
      expectedUpdatedAt: line.updatedAt.toISOString(),
    }));
    const row = await prisma.purchaseOrderLine.findUnique({ where: { id: line.id } });
    expect(row?.qty).toBe(7);
    expect(Number(row?.unitCost)).toBe(12.34);
  });

  it("cannot edit a line on another garage's PO", async () => {
    const { po, line } = await draftPoWithLine(gB, "E2");
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(editPoLineAction, form({
      poId: po.id,
      lineId: line.id,
      qty: "99",
      unitCost: "99.99",
      expectedUpdatedAt: line.updatedAt.toISOString(),
    }));
    const row = await prisma.purchaseOrderLine.findUnique({ where: { id: line.id } });
    expect(row?.qty).toBe(2); // unchanged
    expect(Number(row?.unitCost)).toBe(10.0);
  });

  it("cannot edit a lineId that belongs to a different PO in the same garage", async () => {
    // Two DRAFT POs in gA. Try to edit poA1's lineId while claiming poA2.
    const a1 = await draftPoWithLine(gA, "E3a");
    const a2 = await draftPO(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(editPoLineAction, form({
      poId: a2.id,
      lineId: a1.line.id,
      qty: "99",
      unitCost: "99",
      expectedUpdatedAt: a1.line.updatedAt.toISOString(),
    }));
    const row = await prisma.purchaseOrderLine.findUnique({ where: { id: a1.line.id } });
    expect(row?.qty).toBe(2); // unchanged
  });

  // ── Optimistic concurrency: fresh / stale / deleted ─────────────
  // The stale-write guard narrows the UPDATE by the row's `updatedAt`
  // that was rendered into the edit form's hidden input. A tab that
  // opened before someone else's write must fail loud, not silently
  // overwrite. See docs/optimistic-concurrency-spec.md for why this
  // is scoped to editPoLineAction and not applied app-wide.

  it("happy path: fresh updatedAt from a real DB read + updateMany round-trip", async () => {
    // Guards against the ISO ↔ Prisma ↔ Postgres round-trip losing
    // precision. If timestamp(3) truncates the microseconds our JS
    // Date gave it, every fresh save fails as stale — worse than the
    // bug this replaces. Read the row through the same include shape
    // the detail page uses so the fixture matches production reality.
    const { po, line } = await draftPoWithLine(gA, "F1");
    const readBack = await prisma.purchaseOrderLine.findUnique({ where: { id: line.id } });
    expect(readBack).not.toBeNull();
    mockAuth.mockResolvedValueOnce(owner(gA));
    const redirected = await call(editPoLineAction, form({
      poId: po.id,
      lineId: line.id,
      qty: "9",
      unitCost: "3.50",
      expectedUpdatedAt: readBack!.updatedAt.toISOString(),
    }));
    // Should have redirected back to the PO detail page (no error).
    expect(redirected).not.toContain("error=");
    const after = await prisma.purchaseOrderLine.findUnique({ where: { id: line.id } });
    expect(after?.qty).toBe(9);
    expect(Number(after?.unitCost)).toBe(3.5);
  });

  it("stale updatedAt: refuses the write, row unchanged", async () => {
    const { po, line } = await draftPoWithLine(gA, "F2");
    const captured = line.updatedAt.toISOString();
    // Simulate another tab writing between the render (captured) and
    // this save. A raw SQL update advances `updatedAt` server-side —
    // Prisma's `updateMany` with the auto @updatedAt would also
    // advance it, but keeping the qty/cost stable makes the assert
    // downstream unambiguous.
    await prisma.$executeRaw`UPDATE "PurchaseOrderLine" SET "updatedAt" = NOW() + INTERVAL '1 second' WHERE id = ${line.id}`;
    mockAuth.mockResolvedValueOnce(owner(gA));
    const redirected = await call(editPoLineAction, form({
      poId: po.id,
      lineId: line.id,
      qty: "77",
      unitCost: "77.77",
      expectedUpdatedAt: captured,
    }));
    expect(redirected).toContain("stale_line");
    const after = await prisma.purchaseOrderLine.findUnique({ where: { id: line.id } });
    expect(after?.qty).toBe(2); // unchanged
    expect(Number(after?.unitCost)).toBe(10.0);
  });

  it("deleted row: refuses the write with line_not_found", async () => {
    const { po, line } = await draftPoWithLine(gA, "F3");
    const captured = line.updatedAt.toISOString();
    await prisma.purchaseOrderLine.delete({ where: { id: line.id } });
    mockAuth.mockResolvedValueOnce(owner(gA));
    const redirected = await call(editPoLineAction, form({
      poId: po.id,
      lineId: line.id,
      qty: "77",
      unitCost: "77.77",
      expectedUpdatedAt: captured,
    }));
    expect(redirected).toContain("line_not_found");
  });

  // qty validation
  it.each([
    ["0", "zero"],
    ["-1", "negative"],
    ["1.5", "non-integer"],
    ["abc", "not-a-number"],
    ["", "empty"],
  ])("rejects qty %s (%s)", async (badQty) => {
    const { po, line } = await draftPoWithLine(gA, `q-${badQty || "empty"}`);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(
      editPoLineAction,
      form({ poId: po.id, lineId: line.id, qty: badQty, unitCost: "5" }),
    );
    expect(to).toContain("error=");
    const row = await prisma.purchaseOrderLine.findUnique({ where: { id: line.id } });
    expect(row?.qty).toBe(2); // unchanged
    expect(Number(row?.unitCost)).toBe(10.0);
  });

  // unitCost validation
  it.each([
    ["-0.01", "negative-cent"],
    ["-5", "negative"],
    ["abc", "not-a-number"],
    ["", "empty"],
  ])("rejects unitCost %s (%s)", async (badCost) => {
    const { po, line } = await draftPoWithLine(gA, `c-${badCost || "empty"}`);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(
      editPoLineAction,
      form({ poId: po.id, lineId: line.id, qty: "3", unitCost: badCost }),
    );
    expect(to).toContain("error=");
    const row = await prisma.purchaseOrderLine.findUnique({ where: { id: line.id } });
    expect(row?.qty).toBe(2); // unchanged
  });

  it("accepts unitCost of 0 (free stock counts as a real transaction)", async () => {
    const { po, line } = await draftPoWithLine(gA, "E-zero");
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(editPoLineAction, form({
      poId: po.id,
      lineId: line.id,
      qty: "1",
      unitCost: "0",
      expectedUpdatedAt: line.updatedAt.toISOString(),
    }));
    const row = await prisma.purchaseOrderLine.findUnique({ where: { id: line.id } });
    expect(Number(row?.unitCost)).toBe(0);
  });

  // DRAFT-only guard — pin every non-DRAFT state, not just one. This is
  // the load-bearing invariant for the receiving math.
  //
  // Note: ORDERED needs orderedAt to be non-null in the schema semantics,
  // but the schema doesn't enforce it. We set the status directly and
  // don't seed receivedQty for ORDERED / CANCELLED (both have received
  // nothing). For PARTIALLY_RECEIVED and RECEIVED we do seed receivedQty
  // > 0 so the fixture is realistic.
  it.each([
    ["ORDERED", 0],
    ["PARTIALLY_RECEIVED", 1],
    ["RECEIVED", 2],
    ["CANCELLED", 0],
  ] as const)("rejects edit on %s status", async (status, receivedQty) => {
    const { po, line } = await draftPoWithLine(gA, `s-${status}`);
    // Move to the target non-DRAFT status.
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status,
        orderedAt: status === "ORDERED" || status === "PARTIALLY_RECEIVED" || status === "RECEIVED" ? new Date() : null,
        receivedAt: status === "RECEIVED" ? new Date() : null,
      },
    });
    if (receivedQty > 0) {
      await prisma.purchaseOrderLine.update({
        where: { id: line.id },
        data: { receivedQty },
      });
    }
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(
      editPoLineAction,
      form({ poId: po.id, lineId: line.id, qty: "99", unitCost: "99" }),
    );
    expect(to).toContain("error=");
    const row = await prisma.purchaseOrderLine.findUnique({ where: { id: line.id } });
    // Original qty and unitCost — unchanged. If we let the edit through
    // on PARTIALLY_RECEIVED the receiving math would break; this is what
    // that assertion protects.
    expect(row?.qty).toBe(2);
    expect(Number(row?.unitCost)).toBe(10.0);
  });

  it("rejects a non-owner-family role", async () => {
    const { po, line } = await draftPoWithLine(gA, "E-role");
    mockAuth.mockResolvedValueOnce({
      user: { id: "x", role: "ADVISOR", garageId: gA, email: "x", name: "x" },
    });
    await expect(
      editPoLineAction(form({ poId: po.id, lineId: line.id, qty: "3", unitCost: "5" })),
    ).rejects.toThrow("Not authorized");
  });
});

// ---------------------------------------------------------------------------
// 2b — PARTIAL receiving into stock. This is the stock-integrity slice.
// ---------------------------------------------------------------------------
let poSeq = 0;
async function orderedPO(
  garageId: string,
  specs: { startStock: number; qty: number }[],
) {
  const s = await supplier(garageId);
  const po = await prisma.purchaseOrder.create({
    data: { garageId, supplierId: s.id, status: "ORDERED", reference: "PO-R" },
  });
  const lines = [];
  for (const [i, spec] of specs.entries()) {
    const p = await prisma.part.create({
      data: { garageId, sku: `RCV-${poSeq++}-${i}`, name: "Recv " + i, cost: "5", price: "9", qtyOnHand: spec.startStock },
    });
    const line = await prisma.purchaseOrderLine.create({
      data: { purchaseOrderId: po.id, partId: p.id, qty: spec.qty, unitCost: "5" },
    });
    lines.push({ line, part: p });
  }
  return { po, lines };
}
function receiveForm(poId: string, receipts: { lineId: string; qty: number }[]): FormData {
  const fd = new FormData();
  fd.set("poId", poId);
  for (const r of receipts) fd.set(`recv_${r.lineId}`, String(r.qty));
  return fd;
}
const qtyOf = async (partId: string) =>
  (await prisma.part.findUnique({ where: { id: partId } }))?.qtyOnHand;
const recvOf = async (lineId: string) =>
  (await prisma.purchaseOrderLine.findUnique({ where: { id: lineId } }))?.receivedQty;
const statusOf = async (poId: string) =>
  (await prisma.purchaseOrder.findUnique({ where: { id: poId } }))?.status;
const movesOf = async (partId: string) =>
  prisma.partMovement.findMany({ where: { partId } });

describe("receivePurchaseOrderAction — 2b PARTIAL receiving", { retry: 3 }, () => {
  it("receive PART then the REST — stock adds each time, total exact, status flows", async () => {
    const { po, lines } = await orderedPO(gA, [{ startStock: 100, qty: 10 }]);
    const L = lines[0];

    // Receive 6 of 10.
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: L.line.id, qty: 6 }]));
    expect(await qtyOf(L.part.id)).toBe(106); // +6
    expect(await recvOf(L.line.id)).toBe(6);
    expect(await statusOf(po.id)).toBe("PARTIALLY_RECEIVED");

    // Receive the remaining 4.
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: L.line.id, qty: 4 }]));
    expect(await qtyOf(L.part.id)).toBe(110); // +10 total, NEVER +20
    expect(await recvOf(L.line.id)).toBe(10);
    const poRow = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
    expect(poRow?.status).toBe("RECEIVED");
    expect(poRow?.receivedAt).not.toBeNull();
    expect((await movesOf(L.part.id)).length).toBe(2); // one movement per receipt
  });

  it("BLOCKS receiving more than outstanding (up front AND after a partial)", async () => {
    const { po, lines } = await orderedPO(gA, [{ startStock: 0, qty: 10 }]);
    const L = lines[0];

    // 11 > 10 ordered → blocked, nothing applied.
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to1 = await call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: L.line.id, qty: 11 }]));
    expect(to1).toContain("error=");
    expect(await qtyOf(L.part.id)).toBe(0);
    expect(await recvOf(L.line.id)).toBe(0);

    // Receive 6, then 5 (outstanding is only 4) → blocked.
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: L.line.id, qty: 6 }]));
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to2 = await call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: L.line.id, qty: 5 }]));
    expect(to2).toContain("error=");
    expect(await qtyOf(L.part.id)).toBe(6); // still just the 6
    expect(await recvOf(L.line.id)).toBe(6);
  });

  it("CONCURRENT double-submit of the full outstanding adds ONCE (no double-count)", async () => {
    const { po, lines } = await orderedPO(gA, [{ startStock: 0, qty: 10 }]);
    const L = lines[0];
    mockAuth.mockResolvedValue(owner(gA));
    try {
      const results = await Promise.allSettled([
        call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: L.line.id, qty: 10 }])),
        call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: L.line.id, qty: 10 }])),
      ]);
      expect(await qtyOf(L.part.id)).toBe(10); // once, not 20
      expect(await recvOf(L.line.id)).toBe(10);
      expect((await movesOf(L.part.id)).length).toBe(1);
      const urls = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      expect(urls.some((u) => /error=/.test(u))).toBe(true); // the loser was blocked
    } finally {
      mockAuth.mockReset();
    }
  });

  it("blocks receiving nothing (all zero)", async () => {
    const { po, lines } = await orderedPO(gA, [{ startStock: 5, qty: 10 }]);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: lines[0].line.id, qty: 0 }]));
    expect(to).toContain("error=");
    expect(await qtyOf(lines[0].part.id)).toBe(5);
  });

  it("blocks receiving a cancelled PO", async () => {
    const s = await supplier(gA);
    const po = await prisma.purchaseOrder.create({ data: { garageId: gA, supplierId: s.id, status: "CANCELLED" } });
    const p = await part(gA, "CAN");
    const line = await prisma.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, partId: p.id, qty: 5, unitCost: "1" } });
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: line.id, qty: 5 }]));
    expect(to).toContain("error=");
    expect(await qtyOf(p.id)).toBe(0);
  });

  it("multi-line: one line partial + one line full → PO is PARTIALLY_RECEIVED", async () => {
    const { po, lines } = await orderedPO(gA, [{ startStock: 0, qty: 10 }, { startStock: 0, qty: 5 }]);
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(
      receivePurchaseOrderAction,
      receiveForm(po.id, [
        { lineId: lines[0].line.id, qty: 4 }, // 4/10 — partial
        { lineId: lines[1].line.id, qty: 5 }, // 5/5 — full
      ]),
    );
    expect(await qtyOf(lines[0].part.id)).toBe(4);
    expect(await qtyOf(lines[1].part.id)).toBe(5);
    expect(await statusOf(po.id)).toBe("PARTIALLY_RECEIVED");
  });

  it("cannot receive another garage's PO", async () => {
    const { po, lines } = await orderedPO(gB, [{ startStock: 7, qty: 20 }]);
    mockAuth.mockResolvedValueOnce(owner(gA)); // A tries to receive B's PO
    await call(receivePurchaseOrderAction, receiveForm(po.id, [{ lineId: lines[0].line.id, qty: 5 }]));
    expect(await qtyOf(lines[0].part.id)).toBe(7); // untouched
    expect(await statusOf(po.id)).toBe("ORDERED");
  });
});

// ---------------------------------------------------------------------------
// 2c — PURCHASE RETURNS. Stock-integrity slice: return received parts to the
// supplier → stock DOWN, capped at received, never negative.
// ---------------------------------------------------------------------------
async function receivedPO(
  garageId: string,
  specs: { stock: number; ordered: number; received: number }[],
  status: "RECEIVED" | "PARTIALLY_RECEIVED" = "RECEIVED",
) {
  const s = await supplier(garageId);
  const po = await prisma.purchaseOrder.create({
    data: { garageId, supplierId: s.id, status, reference: "PO-RET" },
  });
  const lines = [];
  for (const [i, spec] of specs.entries()) {
    const p = await prisma.part.create({
      data: { garageId, sku: `RET-${poSeq++}-${i}`, name: "Ret " + i, cost: "5", price: "9", qtyOnHand: spec.stock },
    });
    const line = await prisma.purchaseOrderLine.create({
      data: { purchaseOrderId: po.id, partId: p.id, qty: spec.ordered, receivedQty: spec.received, unitCost: "5" },
    });
    lines.push({ line, part: p });
  }
  return { po, lines };
}
function returnForm(poId: string, rets: { lineId: string; qty: number }[]): FormData {
  const fd = new FormData();
  fd.set("poId", poId);
  for (const r of rets) fd.set(`ret_${r.lineId}`, String(r.qty));
  return fd;
}
const returnedOf = async (lineId: string) =>
  (await prisma.purchaseOrderLine.findUnique({ where: { id: lineId } }))?.returnedQty;

describe("returnPurchaseOrderAction — 2c purchase returns", { retry: 3 }, () => {
  it("returns WITHIN received — stock drops, returnedQty rises, movement logged", async () => {
    const { po, lines } = await receivedPO(gA, [{ stock: 50, ordered: 10, received: 10 }]);
    const L = lines[0];
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 4 }]));
    expect(await qtyOf(L.part.id)).toBe(46); // 50 − 4
    expect(await returnedOf(L.line.id)).toBe(4);
    const moves = await movesOf(L.part.id);
    expect(moves.length).toBe(1);
    expect(moves[0].delta).toBe(-4); // negative — stock left
    expect(moves[0].reason).toMatch(/Returned to supplier/);

    // Return the remaining 6 → returnedQty 10, stock 40.
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 6 }]));
    expect(await qtyOf(L.part.id)).toBe(40); // −10 total
    expect(await returnedOf(L.line.id)).toBe(10);
  });

  it("BLOCKS returning more than was received (up front AND after a partial return)", async () => {
    const { po, lines } = await receivedPO(gA, [{ stock: 50, ordered: 10, received: 10 }]);
    const L = lines[0];

    // 11 > 10 received → blocked.
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to1 = await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 11 }]));
    expect(to1).toContain("error=");
    expect(await qtyOf(L.part.id)).toBe(50);
    expect(await returnedOf(L.line.id)).toBe(0);

    // Return 6, then 5 (only 4 returnable) → blocked.
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 6 }]));
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to2 = await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 5 }]));
    expect(to2).toContain("error=");
    expect(await qtyOf(L.part.id)).toBe(44); // still just −6
    expect(await returnedOf(L.line.id)).toBe(6);
  });

  it("BLOCKS a return that would drive stock negative (stock already used on jobs)", async () => {
    // Received 10 but only 3 remain on hand (7 consumed elsewhere). Returning 5
    // is within received but would take stock to −2 → blocked.
    const { po, lines } = await receivedPO(gA, [{ stock: 3, ordered: 10, received: 10 }]);
    const L = lines[0];
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 5 }]));
    expect(to).toContain("error=");
    expect(await qtyOf(L.part.id)).toBe(3); // untouched
    expect(await returnedOf(L.line.id)).toBe(0);
  });

  it("CONCURRENT double-return of the full returnable decrements ONCE (no double)", async () => {
    const { po, lines } = await receivedPO(gA, [{ stock: 50, ordered: 10, received: 10 }]);
    const L = lines[0];
    mockAuth.mockResolvedValue(owner(gA));
    try {
      const results = await Promise.allSettled([
        call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 10 }])),
        call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 10 }])),
      ]);
      expect(await qtyOf(L.part.id)).toBe(40); // −10 once, not −20
      expect(await returnedOf(L.line.id)).toBe(10);
      expect((await movesOf(L.part.id)).length).toBe(1);
      const urls = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      expect(urls.some((u) => /error=/.test(u))).toBe(true);
    } finally {
      mockAuth.mockReset();
    }
  });

  it("blocks returning nothing (all zero)", async () => {
    const { po, lines } = await receivedPO(gA, [{ stock: 50, ordered: 10, received: 10 }]);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: lines[0].line.id, qty: 0 }]));
    expect(to).toContain("error=");
    expect(await qtyOf(lines[0].part.id)).toBe(50);
  });

  it("won't return from an order with nothing received (ORDERED)", async () => {
    const { po, lines } = await orderedPO(gA, [{ startStock: 20, qty: 10 }]); // ORDERED, receivedQty 0
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: lines[0].line.id, qty: 3 }]));
    expect(to).toContain("error=");
    expect(await qtyOf(lines[0].part.id)).toBe(20);
  });

  it("allows a return from a PARTIALLY_RECEIVED order (up to what was received)", async () => {
    const { po, lines } = await receivedPO(gA, [{ stock: 30, ordered: 10, received: 6 }], "PARTIALLY_RECEIVED");
    const L = lines[0];
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 4 }]));
    expect(await qtyOf(L.part.id)).toBe(26); // 30 − 4
    expect(await returnedOf(L.line.id)).toBe(4);
    // can't now return 3 (only 2 of the 6 received remain returnable)
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: L.line.id, qty: 3 }]));
    expect(to).toContain("error=");
    expect(await qtyOf(L.part.id)).toBe(26);
  });

  it("cannot return another garage's PO", async () => {
    const { po, lines } = await receivedPO(gB, [{ stock: 40, ordered: 10, received: 10 }]);
    mockAuth.mockResolvedValueOnce(owner(gA)); // A tries to return B's PO
    await call(returnPurchaseOrderAction, returnForm(po.id, [{ lineId: lines[0].line.id, qty: 5 }]));
    expect(await qtyOf(lines[0].part.id)).toBe(40); // untouched
    expect(await returnedOf(lines[0].line.id)).toBe(0);
  });
});
