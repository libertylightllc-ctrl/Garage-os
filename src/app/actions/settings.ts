"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// Self-serve account/garage settings. Each action is keyed to
// session.user.id (or session.user.garageId for owner-only actions) —
// never to anything in formData. A tampered POST cannot aim at a
// different user or garage row.

function back(error: string): never {
  redirect(`/settings?error=${encodeURIComponent(error)}`);
}

export async function updateProfileNameAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) back("name-required");
  if (name.length > 80) back("name-too-long");

  // Strictly scoped by session id — cannot ever touch a different row.
  await prisma.user.update({
    where: { id: session.user.id },
    data: { name },
  });

  revalidatePath("/settings");
  redirect("/settings?ok=name");
}

// Loose RFC-5322-ish format check — exactly the same as a browser
// type="email" input would do. Server doesn't need bullet-proof
// validation; the @unique index + downstream login attempt are the
// authoritative checks.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function updateProfileEmailAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const userId = session.user.id;
  const newEmail = String(formData.get("newEmail") ?? "").toLowerCase().trim();
  const currentPassword = String(formData.get("currentPassword") ?? "");

  if (!newEmail || !currentPassword) back("email-missing");
  if (!EMAIL_RE.test(newEmail) || newEmail.length > 200) back("email-invalid");

  // Read this user's current row by session id — once again, never an
  // address from the form. Identical pattern to changePasswordAction.
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, passwordHash: true },
  });
  if (!me) redirect("/login");

  // If they have no password set yet (e.g. invited but never set), we
  // can't gate on it — refuse cleanly so they go set one first.
  if (!me.passwordHash) back("email-no-password");

  // No-op short-circuit. Cheaper than the bcrypt + uniqueness checks
  // below, and avoids the "Database changed 0 rows" path entirely.
  if (newEmail === me.email) {
    redirect("/settings?ok=email-unchanged");
  }

  const currentOk = await bcrypt.compare(currentPassword, me.passwordHash);
  if (!currentOk) back("email-current-wrong");

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { email: newEmail },
    });
  } catch (e) {
    // P2002 = unique constraint on User.email. We intentionally
    // surface a generic "already in use" without naming the field, so
    // an attacker can't probe whether an email exists in the system.
    // Duck-typed check on the error code so we don't depend on
    // Prisma's internal class layout (which has moved between
    // versions).
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: unknown }).code === "P2002"
    ) {
      back("email-taken");
    }
    throw e;
  }

  revalidatePath("/settings");
  redirect("/settings?ok=email");
}
