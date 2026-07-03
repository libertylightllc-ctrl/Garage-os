import {
  createGarageWithOwner,
  CreateGarageError,
} from "@/lib/create-garage";
import { prisma } from "@/lib/prisma";
import { logAdminAccess } from "@/lib/admin-audit";
import type { AdminContext } from "@/lib/admin-auth";

// Phase 4: admin-driven tenant creation.
//
// Two layers, by design:
//   1. createGarageWithOwner() (lib/create-garage.ts) — framework-free
//      core that the operator script + this helper both call. One code
//      path for "actually insert a Garage and its OWNER user."
//   2. adminCreateGarage() — admin-only wrapper that validates input
//      under stricter rules (password ≥12 chars, valid email shape),
//      writes an AdminAuditLog row for every outcome (success or fail),
//      and never throws to the caller — returns a discriminated union
//      so the form action can render an error message instead of a 500.
//
// Tenant safety:
//   - Takes AdminContext as the first arg. Same signature trick as the
//     Phase 3 detail layer; only requireAdmin() can produce one.
//   - logAdminAccess captures actorAdminId on success (the real admin).
//     On failure, actorAdminId stays the admin too — failed creates are
//     a real admin trying something, not anonymous probes.

export interface AdminCreateGarageInput {
  garageName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  trn: string | null;
  isPilot: boolean;
}

export type AdminCreateGarageResult =
  | { ok: true; garageId: string; ownerId: string; garageName: string }
  | { ok: false; error: string; code: AdminCreateGarageErrorCode };

export type AdminCreateGarageErrorCode =
  | "MISSING_FIELDS"
  | "BAD_EMAIL"
  | "PASSWORD_TOO_SHORT"
  | "EMAIL_EXISTS"
  | "GARAGE_NAME_DUPLICATE"
  | "INTERNAL";

const MIN_PASSWORD_LENGTH = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function audit(
  admin: AdminContext,
  ok: boolean,
  meta: Record<string, unknown>,
  targetGarageId?: string
): Promise<void> {
  await logAdminAccess({
    actorAdminId: admin.id,
    action: ok ? "garage_created" : "garage_create_failed",
    targetType: "Garage",
    targetId: targetGarageId,
    targetGarageId,
    meta,
  });
}

export async function adminCreateGarage(
  admin: AdminContext,
  input: AdminCreateGarageInput
): Promise<AdminCreateGarageResult> {
  const garageName = input.garageName.trim();
  const ownerName = input.ownerName.trim();
  const ownerEmail = input.ownerEmail.toLowerCase().trim();
  const ownerPassword = input.ownerPassword;
  const trn = input.trn?.trim() || null;

  // ---- validation (admin layer, stricter than the operator script) ----

  if (!garageName || !ownerName || !ownerEmail || !ownerPassword) {
    await audit(admin, false, {
      reason: "MISSING_FIELDS",
      garageName: !!garageName,
      ownerName: !!ownerName,
      ownerEmail: !!ownerEmail,
      ownerPassword: !!ownerPassword,
    });
    return {
      ok: false,
      code: "MISSING_FIELDS",
      error: "Garage name, owner name, email, and password are all required.",
    };
  }

  if (!EMAIL_RE.test(ownerEmail)) {
    await audit(admin, false, { reason: "BAD_EMAIL", ownerEmail });
    return {
      ok: false,
      code: "BAD_EMAIL",
      error: "Owner email is not a valid email address.",
    };
  }

  if (ownerPassword.length < MIN_PASSWORD_LENGTH) {
    await audit(admin, false, {
      reason: "PASSWORD_TOO_SHORT",
      length: ownerPassword.length,
    });
    return {
      ok: false,
      code: "PASSWORD_TOO_SHORT",
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  // ---- soft duplicate check on garage name (within UAE) ----
  // The DB has no unique constraint on Garage.name — there's no business
  // reason names must be unique forever. But "Demo Garage" vs "Demo
  // Garage" is almost certainly a typo, so we warn the admin via this
  // failure path instead of silently creating a second tenant with the
  // same name. They can rename one if they really mean two.
  const existingGarage = await prisma.garage.findFirst({
    where: { name: garageName, country: "UAE" },
    select: { id: true },
  });
  if (existingGarage) {
    await audit(admin, false, {
      reason: "GARAGE_NAME_DUPLICATE",
      garageName,
      existingGarageId: existingGarage.id,
    });
    return {
      ok: false,
      code: "GARAGE_NAME_DUPLICATE",
      error: `A UAE garage named "${garageName}" already exists.`,
    };
  }

  // ---- delegate to the framework-free core ----

  try {
    const r = await createGarageWithOwner({
      garageName,
      ownerName,
      ownerEmail,
      ownerPassword,
      trn,
    });

    // Apply isPilot AFTER core insert — core's default is true so the
    // common case is a no-op. We update only if the admin explicitly
    // requested non-pilot.
    if (!input.isPilot) {
      await prisma.garage.update({
        where: { id: r.garageId },
        data: { isPilot: false },
      });
    }

    await audit(
      admin,
      true,
      {
        garageName: r.garageName,
        ownerEmail: r.email,
        ownerName: r.ownerName,
        isPilot: input.isPilot,
      },
      r.garageId
    );

    return {
      ok: true,
      garageId: r.garageId,
      ownerId: r.ownerId,
      garageName: r.garageName,
    };
  } catch (e) {
    // createGarageWithOwner can throw CreateGarageError for the same
    // failure modes we already covered above (MISSING_FIELDS,
    // PASSWORD_TOO_SHORT, EMAIL_EXISTS). The only one our validation
    // doesn't catch is EMAIL_EXISTS — translate it through.
    if (e instanceof CreateGarageError && e.code === "EMAIL_EXISTS") {
      await audit(admin, false, { reason: "EMAIL_EXISTS", ownerEmail });
      return {
        ok: false,
        code: "EMAIL_EXISTS",
        error: "A user with that email already exists in the system.",
      };
    }

    // Any other throw is unexpected — log it AND surface a generic
    // error to the admin. We don't want our admin to see a raw stack.
    console.error("[adminCreateGarage] unexpected error:", e);
    await audit(admin, false, {
      reason: "INTERNAL",
      message: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      code: "INTERNAL",
      error: "Internal error while creating the garage. Try again.",
    };
  }
}
