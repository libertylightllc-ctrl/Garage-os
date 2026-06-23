import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  validatePasswordChange,
} from "@/lib/password-change";

const CURRENT_PLAIN = "old-correct-password";
const NEW_PLAIN = "newSecret!42";

async function makeStoredHash(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

describe("validatePasswordChange", () => {
  it("succeeds when current is correct, new is long enough, and confirm matches", async () => {
    const storedHash = await makeStoredHash(CURRENT_PLAIN);
    const r = await validatePasswordChange({
      currentPlain: CURRENT_PLAIN,
      newPlain: NEW_PLAIN,
      confirmPlain: NEW_PLAIN,
      storedHash,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    // The new hash must validate the new plain
    expect(await bcrypt.compare(NEW_PLAIN, r.newHash)).toBe(true);
    // ...and must NOT validate the old plain (no accidental re-use)
    expect(await bcrypt.compare(CURRENT_PLAIN, r.newHash)).toBe(false);
    // Cost factor matches the rest of the codebase (10)
    const costMatch = r.newHash.match(/^\$2[aby]\$(\d+)\$/);
    expect(costMatch?.[1]).toBe("10");
  });

  it("rejects with CURRENT_WRONG when current password is wrong (and does not return a hash)", async () => {
    const storedHash = await makeStoredHash(CURRENT_PLAIN);
    const r = await validatePasswordChange({
      currentPlain: "definitely-not-the-current-password",
      newPlain: NEW_PLAIN,
      confirmPlain: NEW_PLAIN,
      storedHash,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("CURRENT_WRONG");
  });

  it("rejects with TOO_SHORT when new password is below the minimum", async () => {
    const storedHash = await makeStoredHash(CURRENT_PLAIN);
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    const r = await validatePasswordChange({
      currentPlain: CURRENT_PLAIN,
      newPlain: short,
      confirmPlain: short,
      storedHash,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("TOO_SHORT");
  });

  it("rejects with MISMATCH when new !== confirm", async () => {
    const storedHash = await makeStoredHash(CURRENT_PLAIN);
    const r = await validatePasswordChange({
      currentPlain: CURRENT_PLAIN,
      newPlain: NEW_PLAIN,
      confirmPlain: NEW_PLAIN + "X",
      storedHash,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("MISMATCH");
  });

  it("rejects with MISSING_FIELDS on any empty input", async () => {
    const storedHash = await makeStoredHash(CURRENT_PLAIN);
    for (const empty of [
      { currentPlain: "" },
      { newPlain: "" },
      { confirmPlain: "" },
    ]) {
      const r = await validatePasswordChange({
        currentPlain: CURRENT_PLAIN,
        newPlain: NEW_PLAIN,
        confirmPlain: NEW_PLAIN,
        storedHash,
        ...empty,
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.error).toBe("MISSING_FIELDS");
    }
  });

  it("checks cheap input errors BEFORE bcrypt-comparing — never reveals current-correctness on a malformed submit", async () => {
    const storedHash = await makeStoredHash(CURRENT_PLAIN);
    // Right current, but the new is too short — must return TOO_SHORT,
    // NOT CURRENT_WRONG (we don't want timing/error to leak whether the
    // attacker guessed the current password).
    const r = await validatePasswordChange({
      currentPlain: CURRENT_PLAIN,
      newPlain: "abc",
      confirmPlain: "abc",
      storedHash,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("TOO_SHORT");
  });
});
