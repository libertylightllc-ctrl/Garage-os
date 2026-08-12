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

/**
 * Owner-only: shop-wide default markup for parts on estimate lines
 * (AR 2026-08-12). The stored value is a HINT used to prefill the
 * per-line markupPct at line-create time. Existing lines are never
 * touched. Cleared (empty input) → nullable, back to "advisor sets
 * per line".
 *
 * Constraints (matched to schema Decimal(5,2)):
 *   - 0 ≤ value ≤ 999.99 %
 *   - up to 2 decimal places (form input coerces via toFixed)
 *
 * Role gate: only OWNER may change shop-wide pricing config. MASTER
 * runs the shop day-to-day but this is a finance-touching setting;
 * we keep it owner-only per the same rule as billing / TRN edits.
 * Non-owner callers get a role-error redirect; the form isn't
 * rendered on their /settings page in the first place.
 */
export async function updateDefaultPartsMarkupAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (session.user.role !== "OWNER") back("role");

  const raw = String(formData.get("defaultPartsMarkupPct") ?? "").trim();
  // Empty → clear (nullable). Blank input is a valid intent: "no
  // shop-wide default, advisor enters per line."
  let value: number | null = null;
  if (raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) back("markup-invalid");
    if (parsed < 0 || parsed > 999.99) back("markup-range");
    value = Math.round(parsed * 100) / 100; // clamp to 2 dp
  }

  // Scoped to the caller's own garage — never trusts a garageId in
  // formData, same pattern as the other owner-scoped actions above.
  await prisma.garage.update({
    where: { id: session.user.garageId },
    data: { defaultPartsMarkupPct: value },
  });

  revalidatePath("/settings");
  redirect("/settings?ok=markup");
}

/**
 * Owner-only: shop-wide default hourly cost of labour (AR 2026-08-12,
 * profit reporting Phase 1, option B). Used to convert WorkSession
 * time-on-job into a labour cost so parts + labour profit can be
 * reported per job / period. See schema comment on
 * Garage.defaultLaborHourlyCost.
 *
 * Constraints (matched to schema Decimal(12,2)):
 *   - 0 ≤ value; upper bound is generous (up to 999999.99) because a
 *     shop's currency isn't fixed here — AED, USD, whatever — and we
 *     shouldn't reject a plausible one just because we didn't imagine
 *     it. Realistically < 500 in AED, but no hard cap in code.
 *   - Up to 2 dp.
 *
 * Blank → clears to null (owner deliberately opts out of labour cost
 * → labour profit rendered as "unknown", not zero).
 */
export async function updateDefaultLaborHourlyCostAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (session.user.role !== "OWNER") back("role");

  const raw = String(formData.get("defaultLaborHourlyCost") ?? "").trim();
  let value: number | null = null;
  if (raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) back("labor-cost-invalid");
    if (parsed < 0) back("labor-cost-range");
    value = Math.round(parsed * 100) / 100; // clamp to 2 dp
  }

  await prisma.garage.update({
    where: { id: session.user.garageId },
    data: { defaultLaborHourlyCost: value },
  });

  revalidatePath("/settings");
  redirect("/settings?ok=labor-cost");
}
