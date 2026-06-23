import bcrypt from "bcryptjs";

// Single source of truth for "change password" validation + hashing.
// Kept framework-free (no next/navigation, no prisma) so the test in
// password-change.test.ts can exercise it without needing the dev DB.
//
// Same hashing cost (bcrypt 10) and same min-length rule (6) as the
// rest of the codebase — see src/lib/create-garage.ts and the
// addStaffAction in onboarding.ts. Don't drift these or one role
// would end up with weaker hashes than another.

export const MIN_PASSWORD_LENGTH = 6;

export type PasswordChangeErrorCode =
  | "MISSING_FIELDS"
  | "TOO_SHORT"
  | "MISMATCH"
  | "CURRENT_WRONG";

export type PasswordChangeResult =
  | { ok: true; newHash: string }
  | { ok: false; error: PasswordChangeErrorCode };

export interface PasswordChangeInput {
  currentPlain: string;
  newPlain: string;
  confirmPlain: string;
  storedHash: string;
}

export async function validatePasswordChange(
  input: PasswordChangeInput,
): Promise<PasswordChangeResult> {
  // Order of checks matters — keep cheap checks first so an attacker
  // can't tell how far they got by timing. (Wrong-current is the only
  // bcrypt-compare and is intentionally last among the "user-facing
  // input" checks.)
  if (!input.currentPlain || !input.newPlain || !input.confirmPlain) {
    return { ok: false, error: "MISSING_FIELDS" };
  }
  if (input.newPlain.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: "TOO_SHORT" };
  }
  if (input.newPlain !== input.confirmPlain) {
    return { ok: false, error: "MISMATCH" };
  }
  const currentOk = await bcrypt.compare(input.currentPlain, input.storedHash);
  if (!currentOk) {
    return { ok: false, error: "CURRENT_WRONG" };
  }
  const newHash = await bcrypt.hash(input.newPlain, 10);
  return { ok: true, newHash };
}
