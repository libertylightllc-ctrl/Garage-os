"use server";

// Per-garage logo upload + remove. OWNER-only, strictly session-scoped:
// the garageId comes from the auth session, never from form input, so a
// forged form cannot ever touch another garage's logoUrl. Validation is
// the real security boundary — see src/lib/storage.ts validateLogoFile
// for the magic-byte sniff, MIME allowlist, and 500 KB cap. The client
// UI mirrors those checks for UX, but the server re-validates because
// nothing the client says can be trusted.
//
// Replace flow: the new file uploads first, THEN the DB updates, THEN
// the old file is best-effort deleted. If anything fails before the DB
// write succeeds, the OLD logo stays intact (no half-replaced state).
// If the delete-old step fails after a successful DB write, the new
// logo is live and the orphan is wasted storage, not a correctness bug
// — logged not thrown.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import {
  saveLogoUpload,
  deleteLogoUpload,
  LogoValidationError,
} from "@/lib/storage";

/**
 * Owner uploads (or replaces) the garage's logo. Validates type/size
 * server-side; rejects SVG, oversized files, and Content-Type spoofs.
 * Re-render /settings + /owner so the new brand shows immediately.
 */
export async function uploadGarageLogoAction(formData: FormData): Promise<void> {
  const session = await requireRole("OWNER");
  const garageId = session.user.garageId;

  const file = formData.get("logo");
  if (!(file instanceof File)) {
    redirect("/settings?error=logo-missing");
  }

  let url: string;
  try {
    // Phase A's saveLogoUpload calls validateLogoFile internally; any
    // failure throws LogoValidationError with a stable .code for
    // user-facing mapping. Wrap so the action never panics on bad
    // input.
    url = await saveLogoUpload(file, garageId);
  } catch (e: unknown) {
    if (e instanceof LogoValidationError) {
      redirect(`/settings?error=logo-${e.code.toLowerCase()}`);
    }
    // Unexpected — re-throw so Next.js logs it and the page shows a
    // generic error. We don't want to swallow a storage / network
    // outage and pretend the upload "worked".
    throw e;
  }

  // Fetch the previous logoUrl in the same transaction window — used
  // for orphan cleanup after the update commits.
  const old = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { logoUrl: true },
  });

  await prisma.garage.update({
    where: { id: garageId },
    data: { logoUrl: url },
  });

  // Delete the previous file AFTER the DB write commits, so a failure
  // here cannot wipe a logo whose URL is still referenced. Best effort:
  // deleteLogoUpload never throws (parsed-url miss = no-op, SDK error
  // logged to console).
  if (old?.logoUrl && old.logoUrl !== url) {
    await deleteLogoUpload(old.logoUrl);
  }

  revalidatePath("/settings");
  revalidatePath("/owner");
  redirect("/settings?ok=logo-saved");
}

/**
 * Owner removes the garage's logo. Sets logoUrl=null in the DB, then
 * best-effort deletes the file. Same OWNER gate + session scoping as
 * upload — a non-owner action call 403s before any DB read.
 */
export async function removeGarageLogoAction(): Promise<void> {
  const session = await requireRole("OWNER");
  const garageId = session.user.garageId;

  const current = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { logoUrl: true },
  });
  if (!current?.logoUrl) {
    // Idempotent: already cleared. No error, no work.
    redirect("/settings?ok=logo-removed");
  }

  await prisma.garage.update({
    where: { id: garageId },
    data: { logoUrl: null },
  });

  // Best-effort cleanup. If this fails after the DB write, the logo no
  // longer renders anywhere and the orphan is wasted storage, not a
  // correctness bug.
  await deleteLogoUpload(current.logoUrl);

  revalidatePath("/settings");
  revalidatePath("/owner");
  redirect("/settings?ok=logo-removed");
}
