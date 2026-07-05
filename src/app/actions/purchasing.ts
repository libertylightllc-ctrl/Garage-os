"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// Inventory Phase 2 — purchasing. OWNER-only, garage-scoped: garageId
// always from the session, and every supplier/part/PO id is re-checked
// against the caller's garage before use (no cross-tenant writes).
//
// 2a covers building + sending a PO (DRAFT → ORDERED) and cancelling.
// Receiving (→ RECEIVED, which moves stock) is 2b — see
// receivePurchaseOrderAction there. Nothing here touches the live
// job / estimate flow.

async function requireOwner() {
  const session = await auth();
  if (!session?.user || session.user.role !== "OWNER") {
    throw new Error("Not authorized");
  }
  return session.user;
}

function fail(msg: string, path = "/owner/purchasing"): never {
  redirect(`${path}?error=${encodeURIComponent(msg)}`);
}

function optional(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? "").trim();
  return s === "" ? null : s;
}

/** Non-negative money string for Prisma Decimal; null on invalid. */
function parseMoney(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return s;
}

/** Positive integer; null on invalid. */
function parsePositiveInt(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Create a DRAFT purchase order for a supplier. Lines are added on the
 * detail page. The supplier must be active and in the caller's garage.
 */
export async function createPurchaseOrderAction(formData: FormData) {
  const user = await requireOwner();

  const supplierId = String(formData.get("supplierId") ?? "").trim();
  if (!supplierId) fail("Choose a supplier.", "/owner/purchasing/new");

  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, garageId: user.garageId, active: true },
    select: { id: true },
  });
  if (!supplier) fail("Supplier not found.", "/owner/purchasing/new");

  const po = await prisma.purchaseOrder.create({
    data: {
      garageId: user.garageId, // from session — never from input
      supplierId: supplier.id,
      reference: optional(formData.get("reference")),
      note: optional(formData.get("note")),
    },
    select: { id: true },
  });

  revalidatePath("/owner/purchasing");
  redirect(`/owner/purchasing/${po.id}`);
}

/** Load a PO scoped to the caller's garage, or fail. */
async function ownedPO(poId: string, garageId: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, garageId },
    select: { id: true, status: true },
  });
  return po;
}

/**
 * Add a line to a DRAFT purchase order. The part must be in the caller's
 * garage. Unit cost defaults are handled by the form; here we validate.
 */
export async function addPoLineAction(formData: FormData) {
  const user = await requireOwner();

  const poId = String(formData.get("poId") ?? "").trim();
  const partId = String(formData.get("partId") ?? "").trim();
  const qty = parsePositiveInt(String(formData.get("qty") ?? ""));
  const unitCost = parseMoney(String(formData.get("unitCost") ?? ""));

  const back = `/owner/purchasing/${poId}`;
  if (!poId) fail("Missing purchase order.");

  const po = await ownedPO(poId, user.garageId);
  if (!po) fail("Purchase order not found.");
  if (po.status !== "DRAFT") fail("Lines can only be changed on a draft order.", back);
  if (!partId) fail("Choose a part.", back);
  if (qty === null) fail("Quantity must be a whole number greater than 0.", back);
  if (unitCost === null) fail("Unit cost must be a non-negative number.", back);

  const part = await prisma.part.findFirst({
    where: { id: partId, garageId: user.garageId },
    select: { id: true },
  });
  if (!part) fail("Part not found.", back);

  await prisma.purchaseOrderLine.create({
    data: { purchaseOrderId: po.id, partId: part.id, qty, unitCost },
  });

  revalidatePath(back);
  redirect(back);
}

/** Remove a line from a DRAFT purchase order (both scoped to the garage). */
export async function removePoLineAction(formData: FormData) {
  const user = await requireOwner();

  const poId = String(formData.get("poId") ?? "").trim();
  const lineId = String(formData.get("lineId") ?? "").trim();
  const back = `/owner/purchasing/${poId}`;
  if (!poId || !lineId) fail("Missing line.", back);

  const po = await ownedPO(poId, user.garageId);
  if (!po) fail("Purchase order not found.");
  if (po.status !== "DRAFT") fail("Lines can only be changed on a draft order.", back);

  // Scope the delete through the owned PO so a foreign lineId can't match.
  await prisma.purchaseOrderLine.deleteMany({
    where: { id: lineId, purchaseOrderId: po.id },
  });

  revalidatePath(back);
  redirect(back);
}

/**
 * Move a PO to ORDERED (sent to supplier) or CANCELLED.
 *   - ORDERED requires a DRAFT with at least one line.
 *   - CANCELLED is allowed from DRAFT or ORDERED (not from RECEIVED — that
 *     already moved stock).
 * RECEIVED is a separate action (2b) because it mutates stock.
 */
export async function setPoStatusAction(formData: FormData) {
  const user = await requireOwner();

  const poId = String(formData.get("poId") ?? "").trim();
  const next = String(formData.get("status") ?? "").trim();
  const back = `/owner/purchasing/${poId}`;
  if (!poId) fail("Missing purchase order.");
  if (next !== "ORDERED" && next !== "CANCELLED") fail("Invalid status.", back);

  const po = await ownedPO(poId, user.garageId);
  if (!po) fail("Purchase order not found.");

  if (next === "ORDERED") {
    if (po.status !== "DRAFT") fail("Only a draft order can be sent.", back);
    const lineCount = await prisma.purchaseOrderLine.count({
      where: { purchaseOrderId: po.id },
    });
    if (lineCount === 0) fail("Add at least one line before ordering.", back);
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "ORDERED", orderedAt: new Date() },
    });
  } else {
    if (po.status === "RECEIVED") fail("A received order can't be cancelled.", back);
    if (po.status === "CANCELLED") fail("Already cancelled.", back);
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "CANCELLED" },
    });
  }

  revalidatePath(back);
  revalidatePath("/owner/purchasing");
  redirect(back);
}
