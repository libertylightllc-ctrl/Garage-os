"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOperational } from "@/lib/action-guards";
import type { Lang } from "@/lib/receptionist";

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
 * Operational: shop-wide default markup for parts on estimate lines
 * (AR 2026-08-12; widened to MASTER 2026-08-14). The stored value is
 * a HINT used to prefill the per-line markupPct at line-create time.
 * Existing lines are never touched. Cleared (empty input) → nullable,
 * back to "advisor sets per line".
 *
 * Constraints (matched to schema Decimal(5,2)):
 *   - 0 ≤ value ≤ 999.99 %
 *   - up to 2 decimal places (form input coerces via toFixed)
 *
 * Role gate: OWNER + MASTER via requireOperational() — MASTER is the
 * do-everything operational login and MASTER-signed-in users create
 * estimates too, so the default has to be reachable from that seat or
 * the profit-card link on the invoice page becomes a dead-end (AR
 * 2026-08-14). Pinned by master-owner-boundary.test.ts. The form
 * isn't rendered on non-operational /settings pages in the first place.
 */
export async function updateDefaultPartsMarkupAction(formData: FormData) {
  const session = await requireOperational();

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
    where: { id: session.garageId },
    data: { defaultPartsMarkupPct: value },
  });

  revalidatePath("/settings");
  redirect("/settings?ok=markup");
}

/**
 * Operational: shop-wide default payment terms printed on every
 * estimate (AR 2026-08-25 Batch C). Real UAE-shop example:
 * "50% advance and 50% on delivery". Free text — most shops
 * type the same string every time; a per-estimate override lives
 * on Estimate.paymentTerms for the deviations (fleet net-30, cash
 * on collection). Renderer reads paymentTerms ?? defaultPaymentTerms
 * ?? null; both null → the block doesn't render.
 *
 * Role gate: OWNER + MASTER via requireOperational() — same as
 * the other pricing/document defaults.
 */
export async function updateDefaultPaymentTermsAction(formData: FormData) {
  const session = await requireOperational();
  const raw = String(formData.get("defaultPaymentTerms") ?? "").trim();
  // Empty → null (clears the default; block simply doesn't render
  // until a per-estimate value is set or the default is re-populated).
  const value = raw === "" ? null : raw;
  await prisma.garage.update({
    where: { id: session.garageId },
    data: { defaultPaymentTerms: value },
  });
  revalidatePath("/settings");
  redirect("/settings?ok=payment-terms");
}

/**
 * Operational: shop-wide Terms & Conditions printed at the bottom
 * of every estimate and every invoice (AR 2026-08-25 Batch D).
 * Free text with line breaks preserved on render — most shops
 * carry a fixed set of numbered clauses (validity period, prices
 * subject to change, no warranty on customer-supplied parts, extra
 * work needs approval, part quality categories, road-test
 * authorisation). Deliberately no default wording ships in code —
 * terms are legally the garage's own document.
 *
 * Role gate: OWNER + MASTER via requireOperational() — same as
 * other pricing/document defaults. Sole writer of Garage.terms;
 * a single-column write. Empty string clears to null (block stops
 * rendering on both surfaces).
 */
export async function updateGarageTermsAction(formData: FormData) {
  const session = await requireOperational();
  const raw = String(formData.get("terms") ?? "").trim();
  const value = raw === "" ? null : raw;
  await prisma.garage.update({
    where: { id: session.garageId },
    data: { terms: value },
  });
  revalidatePath("/settings");
  redirect("/settings?ok=terms");
}

/**
 * Operational: shop-wide default hourly cost of labour (AR 2026-08-12,
 * profit reporting Phase 1, option B; widened to MASTER 2026-08-14
 * after AR — signed in as MASTER — hit the profit-card "set labour
 * rate" link and found an OWNER-only /settings page with no field).
 * Used to convert WorkSession time-on-job into a labour cost so parts
 * + labour profit can be reported per job / period. See schema
 * comment on Garage.defaultLaborHourlyCost.
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
 *
 * Role gate: OWNER + MASTER via requireOperational(). Pinned by
 * master-owner-boundary.test.ts.
 */
export async function updateDefaultLaborHourlyCostAction(formData: FormData) {
  const session = await requireOperational();

  const raw = String(formData.get("defaultLaborHourlyCost") ?? "").trim();
  let value: number | null = null;
  if (raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) back("labor-cost-invalid");
    if (parsed < 0) back("labor-cost-range");
    value = Math.round(parsed * 100) / 100; // clamp to 2 dp
  }

  await prisma.garage.update({
    where: { id: session.garageId },
    data: { defaultLaborHourlyCost: value },
  });

  revalidatePath("/settings");
  redirect("/settings?ok=labor-cost");
}

const SUPPORTED_LANGS = ["ar", "en", "hi", "ur"] as const;

// Garage identity editors — split into four per-field actions
// 2026-08-20 (was a single updateGarageDetailsAction from Batch B
// on 2026-08-19; AR hit the two-tab overwrite class where saving
// address wiped defaultLang because the stale <select> value posted
// alongside). One form per input matches the precedent already in
// this file for profile (name vs email) and pricing defaults (parts
// markup vs labour hourly cost). Each write's SET clause names only
// its own column, so a concurrent edit to a sibling field can never
// be overwritten by a save on this one.
//
// Guards: all four use requireOperational() — MASTER runs the shop
// and sets its own identity fields. Pinned by
// master-owner-boundary.test.ts OPERATIONAL_ACTIONS.
//
// Blank string on any optional field = "clear it back to null" (the
// UI reflects this — leaving a field empty and saving removes the
// value rather than sending a zero-length string on to the print
// header). Country + VAT rate stay read-only in the UI; there are
// no actions here for them because they aren't shop preferences.

export async function updateGarageNameAction(formData: FormData) {
  const session = await requireOperational();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) back("garage-name-required");
  if (name.length > 80) back("garage-name-too-long");
  await prisma.garage.update({
    where: { id: session.garageId },
    data: { name },
  });
  revalidatePath("/settings");
  redirect("/settings?ok=garage-name");
}

export async function updateGarageTrnAction(formData: FormData) {
  const session = await requireOperational();
  const raw = String(formData.get("trn") ?? "").trim();
  if (raw.length > 40) back("trn-too-long");
  await prisma.garage.update({
    where: { id: session.garageId },
    data: { trn: raw === "" ? null : raw },
  });
  revalidatePath("/settings");
  redirect("/settings?ok=garage-trn");
}

export async function updateGarageAddressAction(formData: FormData) {
  const session = await requireOperational();
  const raw = String(formData.get("address") ?? "").trim();
  if (raw.length > 400) back("address-too-long");
  await prisma.garage.update({
    where: { id: session.garageId },
    data: { address: raw === "" ? null : raw },
  });
  revalidatePath("/settings");
  redirect("/settings?ok=garage-address");
}

// Sole writer of Garage.defaultLang. No other Prisma call, raw SQL,
// trigger, or migration touches this column. Reports of "the language
// got wiped after I saved something unrelated" (five occurrences up
// to 2026-08-25) were all stale-page reads from the browser session,
// closed after a direct DB read confirmed the stored value was still
// correct. See `docs/business-rules.md` §8 — the reading rule for
// the class, and the specific closure note for this column. Do not
// re-open without a direct DB read that disagrees with the UI.
export async function updateGarageDefaultLangAction(formData: FormData) {
  const session = await requireOperational();
  const raw = String(formData.get("defaultLang") ?? "").trim();
  // Picker only offers "" (no default set), "ar", "en". Anything else
  // in formData is a tampered submit — reject rather than trust it.
  let defaultLang: Lang | null = null;
  if (raw !== "") {
    if (!(SUPPORTED_LANGS as readonly string[]).includes(raw)) {
      back("garage-lang-invalid");
    }
    defaultLang = raw as Lang;
  }
  await prisma.garage.update({
    where: { id: session.garageId },
    data: { defaultLang },
  });
  revalidatePath("/settings");
  redirect("/settings?ok=garage-default-lang");
}
