"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/action-guards";

// Inventory 1c — supplier directory. OWNER-only, garage-scoped: garageId
// always comes from the session, never from form input. Deactivate is a
// SOFT delete (active=false) so historical part references and future
// purchase-order history stay intact — suppliers are never hard-deleted.
//
// This file is deliberately separate from inventory.ts (parts catalog).
// It does NOT touch the job / estimate / part-request flow.


function fail(msg: string, path = "/owner/suppliers"): never {
  redirect(`${path}?error=${encodeURIComponent(msg)}`);
}

/** Trim a string; return null when blank (optional fields store null, not ""). */
function optional(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? "").trim();
  return s === "" ? null : s;
}

/** Very light email sanity check — enough to catch a typo, not RFC-strict. */
function validEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * Create a supplier. Only the name is required; contact person, phone,
 * email, TRN and address are optional. New suppliers are active.
 */
export async function createSupplierAction(formData: FormData) {
  const user = await requireOwner();

  const name = String(formData.get("name") ?? "").trim();
  const email = optional(formData.get("email"));

  if (!name) fail("Supplier name is required.");
  if (email && !validEmail(email)) fail("That email address doesn't look right.");

  await prisma.supplier.create({
    data: {
      garageId: user.garageId, // from session — never from input
      name,
      contactPerson: optional(formData.get("contactPerson")),
      phone: optional(formData.get("phone")),
      email,
      trn: optional(formData.get("trn")),
      address: optional(formData.get("address")),
    },
  });

  revalidatePath("/owner/suppliers");
  redirect("/owner/suppliers");
}

/**
 * Edit a supplier's details. Garage-scoped: the supplier must belong to
 * the caller's garage. Does not change active status (that's its own
 * action so a stray edit can't silently reactivate a supplier).
 */
export async function updateSupplierAction(formData: FormData) {
  const user = await requireOwner();

  const supplierId = String(formData.get("supplierId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = optional(formData.get("email"));

  const back = `/owner/suppliers/${supplierId}`;
  if (!supplierId) fail("Missing supplier.");
  if (!name) fail("Supplier name is required.", back);
  if (email && !validEmail(email)) fail("That email address doesn't look right.", back);

  // Ownership check — the supplier must be in the caller's garage.
  const existing = await prisma.supplier.findFirst({
    where: { id: supplierId, garageId: user.garageId },
    select: { id: true },
  });
  if (!existing) fail("Supplier not found.");

  await prisma.supplier.update({
    where: { id: existing.id },
    data: {
      name,
      contactPerson: optional(formData.get("contactPerson")),
      phone: optional(formData.get("phone")),
      email,
      trn: optional(formData.get("trn")),
      address: optional(formData.get("address")),
    },
  });

  revalidatePath(back);
  revalidatePath("/owner/suppliers");
  redirect(back);
}

/**
 * Soft delete / restore a supplier. `active=false` hides it from pickers
 * and the default directory view but keeps the row (and any part links)
 * intact. Garage-scoped.
 */
export async function setSupplierActiveAction(formData: FormData) {
  const user = await requireOwner();

  const supplierId = String(formData.get("supplierId") ?? "").trim();
  const active = String(formData.get("active") ?? "") === "true";

  const back = `/owner/suppliers/${supplierId}`;
  if (!supplierId) fail("Missing supplier.");

  const existing = await prisma.supplier.findFirst({
    where: { id: supplierId, garageId: user.garageId },
    select: { id: true },
  });
  if (!existing) fail("Supplier not found.");

  await prisma.supplier.update({
    where: { id: existing.id },
    data: { active },
  });

  revalidatePath(back);
  revalidatePath("/owner/suppliers");
  redirect(back);
}
