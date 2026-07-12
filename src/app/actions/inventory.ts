"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/action-guards";

// Inventory Phase 1 — parts catalog management. Kept in its own action
// file, deliberately separate from the live parts.ts (the technician
// part-request flow). Phase 1 only CREATES/READS catalog Part rows and
// their stock level; it does NOT touch the job / estimate / part-request
// flow. The catalog↔job integration (auto-decrement) is Phase 3.
//
// All actions are OWNER-only and garage-scoped: garageId always comes
// from the session, never from form input.


/**
 * Parse a money string into a value Prisma's Decimal accepts. Rejects
 * NaN / Infinity / negatives so a crafted input can't reach the DB as a
 * bad decimal. Returns the trimmed string (Prisma Decimal takes strings).
 */
function parseMoney(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return s;
}

/** Parse a non-negative integer; returns null on invalid. */
function parseCount(raw: string, fallback: number | null = null): number | null {
  const s = raw.trim();
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function fail(msg: string, path = "/owner/inventory"): never {
  redirect(`${path}?error=${encodeURIComponent(msg)}`);
}

/**
 * Create a catalog part. SKU is unique per garage (@@unique([garageId,
 * sku])). Opening stock + reorder level are optional (default 0 / 5).
 */
export async function createPartAction(formData: FormData) {
  const user = await requireOwner();

  const sku = String(formData.get("sku") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const cost = parseMoney(String(formData.get("cost") ?? ""));
  const price = parseMoney(String(formData.get("price") ?? ""));
  const qtyOnHand = parseCount(String(formData.get("qtyOnHand") ?? ""), 0);
  const reorderLevel = parseCount(String(formData.get("reorderLevel") ?? ""), 5);

  if (!sku || !name) fail("SKU and name are required.");
  if (cost === null) fail("Cost must be a non-negative number.");
  if (price === null) fail("Price must be a non-negative number.");
  if (qtyOnHand === null) fail("Opening stock must be a whole number ≥ 0.");
  if (reorderLevel === null) fail("Reorder level must be a whole number ≥ 0.");

  // Uniqueness guard (friendly message before hitting the DB constraint).
  const existing = await prisma.part.findUnique({
    where: { garageId_sku: { garageId: user.garageId, sku } },
    select: { id: true },
  });
  if (existing) fail(`A part with SKU "${sku}" already exists.`);

  await prisma.part.create({
    data: {
      garageId: user.garageId, // from session — never from input
      sku,
      name,
      cost,
      price,
      qtyOnHand,
      reorderLevel,
    },
  });

  revalidatePath("/owner/inventory");
  redirect("/owner/inventory");
}

/**
 * Edit an existing catalog part's details (name, SKU, cost, sale price,
 * reorder level). Stock quantity is NOT edited here — that goes through
 * adjustStockAction so every change is accountable via a PartMovement.
 * Garage-scoped: the part must belong to the caller's garage.
 */
export async function updatePartAction(formData: FormData) {
  const user = await requireOwner();

  const partId = String(formData.get("partId") ?? "").trim();
  const sku = String(formData.get("sku") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const cost = parseMoney(String(formData.get("cost") ?? ""));
  const price = parseMoney(String(formData.get("price") ?? ""));
  const reorderLevel = parseCount(String(formData.get("reorderLevel") ?? ""), 5);
  // OPTIONAL supplier link (1c). Blank = clear the link.
  const supplierIdRaw = String(formData.get("supplierId") ?? "").trim();

  const back = `/owner/inventory/${partId}`;
  if (!partId) fail("Missing part.");
  if (!sku || !name) fail("SKU and name are required.", back);
  if (cost === null) fail("Cost must be a non-negative number.", back);
  if (price === null) fail("Price must be a non-negative number.", back);
  if (reorderLevel === null) fail("Reorder level must be a whole number ≥ 0.", back);

  // Ownership check — the part must be in the caller's garage.
  const part = await prisma.part.findFirst({
    where: { id: partId, garageId: user.garageId },
    select: { id: true, sku: true },
  });
  if (!part) fail("Part not found.");

  // Resolve the optional supplier link. A supplied id must belong to the
  // caller's garage (prevents linking to another tenant's supplier); an
  // unknown/foreign id is treated as "no supplier" rather than an error.
  let supplierId: string | null = null;
  if (supplierIdRaw) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: supplierIdRaw, garageId: user.garageId },
      select: { id: true },
    });
    if (supplier) supplierId = supplier.id;
  }

  // If the SKU changed, keep it unique within the garage.
  if (sku !== part.sku) {
    const clash = await prisma.part.findUnique({
      where: { garageId_sku: { garageId: user.garageId, sku } },
      select: { id: true },
    });
    if (clash) fail(`A part with SKU "${sku}" already exists.`, back);
  }

  await prisma.part.update({
    where: { id: part.id },
    data: { sku, name, cost, price, reorderLevel, supplierId },
  });

  revalidatePath(back);
  revalidatePath("/owner/inventory");
  redirect(back);
}

/**
 * Manual stock adjustment. Increase or decrease a part's on-hand quantity
 * with a REQUIRED reason, recording a PartMovement so every change is
 * accountable. Atomic: the qtyOnHand update and the movement row are one
 * transaction. Reuses the existing PartMovement model (no schema change);
 * manual adjustments have no jobCardId (not job-linked).
 *
 * Does NOT touch the job / estimate / part-request flow — this is the
 * inventory area's own stock accounting (Phase 3 wires job consumption).
 */
export async function adjustStockAction(formData: FormData) {
  const user = await requireOwner();

  const partId = String(formData.get("partId") ?? "").trim();
  const direction = String(formData.get("direction") ?? "").trim(); // add | remove
  const qty = parseCount(String(formData.get("qty") ?? ""));
  const reason = String(formData.get("reason") ?? "").trim();

  const back = `/owner/inventory/${partId}`;
  if (!partId) fail("Missing part.");
  if (direction !== "add" && direction !== "remove") {
    fail("Choose whether to add or remove stock.", back);
  }
  if (qty === null || qty === 0) fail("Enter a quantity greater than 0.", back);
  if (!reason) fail("A reason is required for every stock change.", back);

  const delta = direction === "add" ? qty : -qty;

  const part = await prisma.part.findFirst({
    where: { id: partId, garageId: user.garageId },
    select: { id: true, qtyOnHand: true },
  });
  if (!part) fail("Part not found.");

  const newQty = part.qtyOnHand + delta;
  if (newQty < 0) {
    fail(`Cannot remove ${qty} — only ${part.qtyOnHand} in stock.`, back);
  }

  // Atomic: stock level + audit movement move together or not at all.
  await prisma.$transaction([
    prisma.part.update({ where: { id: part.id }, data: { qtyOnHand: newQty } }),
    prisma.partMovement.create({
      data: { partId: part.id, delta, reason },
    }),
  ]);

  revalidatePath(back);
  revalidatePath("/owner/inventory");
  redirect(back);
}
