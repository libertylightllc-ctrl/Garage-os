"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// Inventory Phase 1 — parts catalog management. Kept in its own action
// file, deliberately separate from the live parts.ts (the technician
// part-request flow). Phase 1 only CREATES/READS catalog Part rows and
// their stock level; it does NOT touch the job / estimate / part-request
// flow. The catalog↔job integration (auto-decrement) is Phase 3.
//
// All actions are OWNER-only and garage-scoped: garageId always comes
// from the session, never from form input.

async function requireOwner() {
  const session = await auth();
  if (!session?.user || session.user.role !== "OWNER") {
    throw new Error("Not authorized");
  }
  return session.user;
}

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

function fail(msg: string): never {
  redirect(`/owner/inventory?error=${encodeURIComponent(msg)}`);
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
