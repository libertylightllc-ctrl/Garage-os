// Brute-force lockout policy, shared by staff (User) and operator
// (AdminUser) login. Pure functions — no DB, no clock except the `now`
// you pass — so the policy is unit-testable in isolation and both
// providers apply IDENTICAL rules.
//
// Model: per-account counter + timed lock.
//   - Each consecutive wrong password increments failedLogins.
//   - When failedLogins reaches MAX_FAILED_LOGINS, lockedUntil is set to
//     now + LOCKOUT_MINUTES. While locked, sign-in is refused BEFORE the
//     password is even checked (so a locked account can't be probed and
//     the counter doesn't grow during the lock).
//   - Any successful sign-in resets the counter to 0 and clears the lock.
//   - After a lock expires, the next wrong attempt starts a FRESH window
//     (counter back to 1) rather than immediately re-locking.
//
// Why per-account and not per-IP: this reuses the failedLogins/lockedUntil
// columns already on AdminUser (now also on User), needs no external
// store, and directly defeats credential-stuffing a known account — the
// real risk with a handful of known shop logins. A per-IP throttle needs
// a shared counter store (Redis/Upstash) and is tracked separately.

// Attempts allowed before the account locks. The Nth wrong attempt is
// the one that trips the lock.
export const MAX_FAILED_LOGINS = 5;

// How long the account stays locked once tripped.
export const LOCKOUT_MINUTES = 15;

/** Is this account currently locked? */
export function isLocked(
  lockedUntil: Date | null | undefined,
  now: Date = new Date()
): boolean {
  return lockedUntil != null && lockedUntil > now;
}

export interface LockoutState {
  failedLogins: number;
  lockedUntil: Date | null;
}

/**
 * Given an account's current lockout columns, compute the new state
 * after ONE failed password attempt.
 *
 * If a previous lock has already expired, the window resets — we count
 * this failure as the first of a fresh streak rather than carrying the
 * stale count forward (which would re-lock instantly after every
 * cooldown).
 */
export function computeFailure(
  record: { failedLogins: number; lockedUntil: Date | null },
  now: Date = new Date()
): LockoutState {
  const staleLockExpired =
    record.lockedUntil != null && record.lockedUntil <= now;
  const priorCount = staleLockExpired ? 0 : record.failedLogins;

  const failedLogins = priorCount + 1;
  const lockedUntil =
    failedLogins >= MAX_FAILED_LOGINS
      ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000)
      : null;

  return { failedLogins, lockedUntil };
}

/** The state to persist after a successful sign-in. */
export function resetState(): LockoutState {
  return { failedLogins: 0, lockedUntil: null };
}
