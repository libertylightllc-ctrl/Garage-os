import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { computeFailure, isLocked, resetState } from "@/lib/login-lockout";

// The credential-verification core for both login providers, extracted
// out of src/auth.ts so the brute-force lockout path is directly
// testable (NextAuth wraps provider.authorize, which is awkward to call
// in a unit test). Each function does the full flow:
//   1. look the account up by email
//   2. refuse if currently locked (BEFORE checking the password, so a
//      locked account can't be probed and the counter can't grow)
//   3. bcrypt-compare; on failure, increment failedLogins / maybe lock
//   4. on success, reset the lockout counters + stamp lastLoginAt
//
// Returns the shaped user object the JWT callback expects, or null on
// any failure (bad email, wrong password, locked). Never throws to the
// caller — a DB write failure on the counter update is swallowed so it
// can't turn a correct password into a refused login.

export interface StaffAuthResult {
  id: string;
  email: string;
  name: string;
  role: string;
  garageId: string;
}

export async function authenticateStaff(
  rawEmail: string,
  password: string
): Promise<StaffAuthResult | null> {
  const email = rawEmail.toLowerCase().trim();
  if (!email || !password) return null;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.passwordHash) return null;

  // Locked → refuse without touching the password or the counter.
  if (isLocked(user.lockedUntil)) return null;

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const next = computeFailure(user);
    await prisma.user
      .update({ where: { id: user.id }, data: next })
      .catch(() => {});
    return null;
  }

  // Success — clear the lockout window + record the login.
  await prisma.user
    .update({
      where: { id: user.id },
      data: { ...resetState(), lastLoginAt: new Date() },
    })
    .catch(() => {});

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    garageId: user.garageId,
  };
}

export interface AdminAuthResult {
  id: string;
  email: string;
  name: string;
  isAdmin: true;
}

export async function authenticateAdmin(
  rawEmail: string,
  password: string
): Promise<AdminAuthResult | null> {
  // Lazy import so admin-audit (which pulls prisma + next/headers) stays
  // out of any edge bundle that might tree-shake through auth.ts.
  const { logAdminAccess } = await import("@/lib/admin-audit");

  const email = rawEmail.toLowerCase().trim();
  if (!email || !password) {
    await logAdminAccess({
      actorAdminId: null,
      action: "login_failed",
      meta: { reason: "missing_credentials", email: email || null },
    });
    return null;
  }

  const admin = await prisma.adminUser.findUnique({ where: { email } });
  if (!admin) {
    await logAdminAccess({
      actorAdminId: null,
      action: "login_failed",
      meta: { reason: "no_such_admin", email },
    });
    return null;
  }

  // Locked → refuse without touching the password or the counter.
  if (isLocked(admin.lockedUntil)) {
    await logAdminAccess({
      actorAdminId: admin.id,
      action: "login_failed",
      meta: { reason: "locked", email },
    });
    return null;
  }

  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) {
    const next = computeFailure(admin);
    await prisma.adminUser
      .update({ where: { id: admin.id }, data: next })
      .catch(() => {});
    await logAdminAccess({
      actorAdminId: admin.id,
      action: "login_failed",
      meta: {
        reason: next.lockedUntil ? "wrong_password_now_locked" : "wrong_password",
        email,
        failedLogins: next.failedLogins,
      },
    });
    return null;
  }

  // Success — clear the lockout window + record the login.
  await prisma.adminUser
    .update({
      where: { id: admin.id },
      data: { ...resetState(), lastLoginAt: new Date() },
    })
    .catch(() => {});
  await logAdminAccess({
    actorAdminId: admin.id,
    action: "login_success",
    meta: { email },
  });

  return { id: admin.id, email: admin.email, name: admin.name, isAdmin: true };
}
