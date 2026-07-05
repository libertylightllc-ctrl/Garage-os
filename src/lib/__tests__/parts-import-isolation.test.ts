/**
 * Inventory OCR import — tests for the review→save path. Two layers:
 *   1. parseInvoiceJson (pure): flags low-confidence / blank / zero values
 *      and NEVER invents data.
 *   2. confirmPartsImportAction: owner-only, garage-scoped; creates catalog
 *      Parts for ONLY the checked, valid rows; skips blank names + duplicate
 *      SKUs; marks the import CONFIRMED; can't touch another garage's import.
 *
 * We seed PartsImport rows directly (no real OCR / storage). Cleanup by
 * garage-id prefix.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { parseInvoiceJson } from "@/lib/ocr";

// ---- pure parser (no DB) ----
describe("parseInvoiceJson — flag, never invent", () => {
  it("flags a line the model marked not-confident, keeping its blanks", () => {
    const raw = JSON.stringify({
      supplierName: "Gulf Parts",
      lines: [
        { name: "Oil Filter", sku: "OF-1", qty: 12, unitCost: 8.5, confident: true },
        { name: "", sku: "WPR-2", qty: 0, unitCost: 0, confident: false },
      ],
    });
    const r = parseInvoiceJson(raw);
    expect(r.supplierName).toBe("Gulf Parts");
    expect(r.lines[0]).toMatchObject({ name: "Oil Filter", sku: "OF-1", qty: 12, unitCost: 8.5, flagged: false });
    // Blank/uncertain line is flagged — NOT filled with a guess.
    expect(r.lines[1].flagged).toBe(true);
    expect(r.lines[1].name).toBe("");
    expect(r.lines[1].unitCost).toBe(0);
  });

  it("flags when a required value is blank even if the model claimed confident", () => {
    const raw = JSON.stringify({ lines: [{ name: "Belt", sku: "", qty: 3, unitCost: 0, confident: true }] });
    const r = parseInvoiceJson(raw);
    expect(r.lines[0].flagged).toBe(true); // unitCost 0 → needs a human
  });

  it("returns no lines for unreadable JSON (never fabricates)", () => {
    expect(parseInvoiceJson("not json at all").lines).toEqual([]);
  });
});

// ---- confirm action (DB, garage-scoped) ----
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { confirmPartsImportAction, discardPartsImportAction } = await import("@/app/actions/parts-import");

const P = "pimport-test-";
const gA = P + "garage-A";
const gB = P + "garage-B";

function owner(garageId: string) {
  return { user: { id: P + "u", role: "OWNER", garageId, email: "x", name: "x" } };
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
// Build a review-form FormData from rows.
function reviewForm(importId: string, rows: { name: string; sku?: string; qty: number; unitCost: number; include: boolean }[]): FormData {
  const fd = new FormData();
  fd.set("importId", importId);
  fd.set("rowCount", String(rows.length));
  rows.forEach((r, i) => {
    fd.set(`name_${i}`, r.name);
    fd.set(`sku_${i}`, r.sku ?? "");
    fd.set(`qty_${i}`, String(r.qty));
    fd.set(`unitCost_${i}`, String(r.unitCost));
    if (r.include) fd.append("include", String(i));
  });
  return fd;
}

async function seedImport(garageId: string, lineCount = 2) {
  return prisma.partsImport.create({
    data: {
      garageId,
      imageUrl: "/api/files/x.jpg",
      status: "DRAFT",
      lines: {
        create: Array.from({ length: lineCount }, (_, i) => ({
          name: "Seed " + i,
          qty: 1,
          unitCost: "1",
        })),
      },
    },
    select: { id: true },
  });
}

async function cleanup() {
  await prisma.partsImportLine.deleteMany({ where: { partsImport: { garageId: { startsWith: P } } } });
  await prisma.partsImport.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.partMovement.deleteMany({ where: { part: { garageId: { startsWith: P } } } });
  await prisma.part.deleteMany({ where: { garageId: { startsWith: P } } });
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

describe("confirmPartsImportAction — review → catalog", { retry: 3 }, () => {
  it("creates catalog parts for only the CHECKED rows, in the caller's garage", async () => {
    const imp = await seedImport(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(
      confirmPartsImportAction,
      reviewForm(imp.id, [
        { name: "Air Filter", sku: "AF-9", qty: 10, unitCost: 12, include: true },
        { name: "Skip Me", sku: "SK-1", qty: 5, unitCost: 4, include: false }, // unchecked
      ]),
    );
    expect(to).toContain("/owner/inventory?imported=1");
    const parts = await prisma.part.findMany({ where: { garageId: gA } });
    expect(parts.length).toBe(1);
    expect(parts[0]).toMatchObject({ sku: "AF-9", name: "Air Filter", qtyOnHand: 10 });
    expect(Number(parts[0].cost)).toBe(12);
    // import is now CONFIRMED
    expect((await prisma.partsImport.findUnique({ where: { id: imp.id } }))?.status).toBe("CONFIRMED");
  });

  it("skips a blank-name row and auto-generates a SKU when blank", async () => {
    const imp = await seedImport(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    await call(
      confirmPartsImportAction,
      reviewForm(imp.id, [
        { name: "", sku: "X", qty: 1, unitCost: 1, include: true }, // blank name → skipped
        { name: "Battery", sku: "", qty: 2, unitCost: 50, include: true }, // blank sku → auto
      ]),
    );
    const parts = await prisma.part.findMany({ where: { garageId: gA } });
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe("Battery");
    expect(parts[0].sku).toMatch(/^IMP-/); // auto-generated
  });

  it("skips a duplicate SKU rather than overwriting an existing part", async () => {
    await prisma.part.create({ data: { garageId: gA, sku: "DUP", name: "Existing", cost: "1", price: "1" } });
    const imp = await seedImport(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const to = await call(
      confirmPartsImportAction,
      reviewForm(imp.id, [{ name: "New One", sku: "DUP", qty: 1, unitCost: 9, include: true }]),
    );
    expect(to).toContain("imported=0");
    expect(to).toContain("skipped=1");
    const existing = await prisma.part.findFirst({ where: { garageId: gA, sku: "DUP" } });
    expect(existing?.name).toBe("Existing"); // untouched
  });

  it("cannot confirm another garage's import", async () => {
    const impB = await seedImport(gB);
    mockAuth.mockResolvedValueOnce(owner(gA)); // A tries to confirm B's import
    const to = await call(confirmPartsImportAction, reviewForm(impB.id, [{ name: "Hack", sku: "H", qty: 1, unitCost: 1, include: true }]));
    expect(to).toContain("error=");
    expect((await prisma.part.findMany({ where: { garageId: gA } })).length).toBe(0);
    expect((await prisma.part.findMany({ where: { garageId: gB } })).length).toBe(0);
    expect((await prisma.partsImport.findUnique({ where: { id: impB.id } }))?.status).toBe("DRAFT");
  });

  it("rejects a non-owner", async () => {
    const imp = await seedImport(gA);
    mockAuth.mockResolvedValueOnce({ user: { id: "x", role: "ADVISOR", garageId: gA, email: "x", name: "x" } });
    await expect(confirmPartsImportAction(reviewForm(imp.id, []))).rejects.toThrow("Not authorized");
  });

  it("discard marks the import DISCARDED (garage-scoped)", async () => {
    const imp = await seedImport(gA);
    mockAuth.mockResolvedValueOnce(owner(gA));
    const fd = new FormData();
    fd.set("importId", imp.id);
    await call(discardPartsImportAction, fd);
    expect((await prisma.partsImport.findUnique({ where: { id: imp.id } }))?.status).toBe("DISCARDED");
  });
});
