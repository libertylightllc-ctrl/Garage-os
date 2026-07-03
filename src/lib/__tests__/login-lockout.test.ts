/**
 * Brute-force lockout tests (H1 from the 2026-07-03 security audit).
 *
 * Two layers:
 *   - Pure-policy unit tests for computeFailure / isLocked (no DB).
 *   - Integration tests driving authenticateStaff / authenticateAdmin
 *     against real seeded rows on the local DB: prove that N consecutive
 *     wrong passwords lock the account, that the CORRECT password is
 *     refused while locked, and that an expired lock resets the window.
 *
 * Cleanup is BY ID PREFIX so a crashed run can't leak rows.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import {
  MAX_FAILED_LOGINS,
  LOCKOUT_MINUTES,
  isLocked,
  computeFailure,
  resetState,
} from "@/lib/login-lockout";

// admin-audit calls next/headers headers(), which throws outside a
// request scope. The helper already swallows that, but stub it so the
// integration tests don't spew. (login-auth imports it lazily.)
vi.mock("next/headers", () => ({
  headers: async () => new Map(),
}));

const { authenticateStaff, authenticateAdmin } = await import(
  "@/lib/login-auth"
);

// ---- pure policy ----

describe("login-lockout policy (pure)", () => {
  it("isLocked: null/past = unlocked, future = locked", () => {
    const now = new Date("2026-07-03T12:00:00Z");
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(new Date("2026-07-03T11:59:00Z"), now)).toBe(false);
    expect(isLocked(new Date("2026-07-03T12:01:00Z"), now)).toBe(true);
  });

  it("computeFailure: increments, and locks exactly on the Nth failure", () => {
    const now = new Date("2026-07-03T12:00:00Z");
    let state = { failedLogins: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < MAX_FAILED_LOGINS; i++) {
      state = computeFailure(state, now);
      expect(state.failedLogins).toBe(i);
      expect(state.lockedUntil).toBeNull(); // not locked yet
    }
    // The MAX_FAILED_LOGINS-th failure trips the lock.
    state = computeFailure(state, now);
    expect(state.failedLogins).toBe(MAX_FAILED_LOGINS);
    expect(state.lockedUntil).not.toBeNull();
    expect(state.lockedUntil!.getTime()).toBe(
      now.getTime() + LOCKOUT_MINUTES * 60_000
    );
  });

  it("computeFailure: an expired lock resets the window to a fresh streak", () => {
    const now = new Date("2026-07-03T12:00:00Z");
    const expired = {
      failedLogins: MAX_FAILED_LOGINS,
      lockedUntil: new Date("2026-07-03T11:00:00Z"), // already passed
    };
    const state = computeFailure(expired, now);
    expect(state.failedLogins).toBe(1); // fresh, not MAX+1
    expect(state.lockedUntil).toBeNull();
  });

  it("resetState clears both fields", () => {
    expect(resetState()).toEqual({ failedLogins: 0, lockedUntil: null });
  });
});

// ---- integration: staff ----

const TEST_PREFIX = "login-lockout-test-";
const PASSWORD = "correct-horse-battery";

async function cleanup() {
  await prisma.adminAuditLog.deleteMany({
    where: { actorAdminId: { startsWith: TEST_PREFIX } },
  });
  await prisma.user.deleteMany({ where: { id: { startsWith: TEST_PREFIX } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: TEST_PREFIX } } });
  await prisma.adminUser.deleteMany({
    where: { id: { startsWith: TEST_PREFIX } },
  });
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("authenticateStaff lockout (integration)", { retry: 3 }, () => {
  const garageId = TEST_PREFIX + "garage";
  const userId = TEST_PREFIX + "user";
  const email = TEST_PREFIX + "staff@example.com";

  beforeEach(async () => {
    await cleanup();
    const hash = await bcrypt.hash(PASSWORD, 4);
    await prisma.garage.create({
      data: { id: garageId, name: TEST_PREFIX + "Garage" },
    });
    await prisma.user.create({
      data: {
        id: userId,
        garageId,
        role: "ADVISOR",
        name: "Locked-out Larry",
        email,
        passwordHash: hash,
      },
    });
  });

  it("correct password succeeds and keeps the counter at zero", async () => {
    const r = await authenticateStaff(email, PASSWORD);
    expect(r?.id).toBe(userId);
    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect(row?.failedLogins).toBe(0);
    expect(row?.lockedUntil).toBeNull();
    expect(row?.lastLoginAt).not.toBeNull();
  });

  it(`locks the account after ${MAX_FAILED_LOGINS} wrong passwords`, async () => {
    for (let i = 1; i <= MAX_FAILED_LOGINS; i++) {
      const r = await authenticateStaff(email, "wrong-password");
      expect(r).toBeNull();
      const row = await prisma.user.findUnique({ where: { id: userId } });
      expect(row?.failedLogins).toBe(i);
      if (i < MAX_FAILED_LOGINS) {
        expect(row?.lockedUntil).toBeNull();
      } else {
        expect(row?.lockedUntil).not.toBeNull();
        expect(isLocked(row?.lockedUntil)).toBe(true);
      }
    }
  });

  it("refuses the CORRECT password while locked", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await authenticateStaff(email, "wrong-password");
    }
    // Account is now locked. Correct password must still be refused.
    const r = await authenticateStaff(email, PASSWORD);
    expect(r).toBeNull();
    // And the counter did NOT grow during the lock (short-circuit before compare).
    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect(row?.failedLogins).toBe(MAX_FAILED_LOGINS);
  });

  it("recovers after the lock expires: correct password succeeds + resets", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await authenticateStaff(email, "wrong-password");
    }
    // Simulate the cooldown elapsing.
    await prisma.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() - 60_000) },
    });
    const r = await authenticateStaff(email, PASSWORD);
    expect(r?.id).toBe(userId);
    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect(row?.failedLogins).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });
});

// ---- integration: admin ----

describe("authenticateAdmin lockout (integration)", { retry: 3 }, () => {
  const adminId = TEST_PREFIX + "admin";
  const email = TEST_PREFIX + "admin@example.com";

  beforeEach(async () => {
    await cleanup();
    const hash = await bcrypt.hash(PASSWORD, 4);
    await prisma.adminUser.create({
      data: {
        id: adminId,
        email,
        name: "Ops Admin",
        passwordHash: hash,
      },
    });
  });

  it("correct password succeeds with isAdmin:true", async () => {
    const r = await authenticateAdmin(email, PASSWORD);
    expect(r?.isAdmin).toBe(true);
    expect(r?.id).toBe(adminId);
  });

  it(`locks after ${MAX_FAILED_LOGINS} wrong passwords and refuses correct one`, async () => {
    for (let i = 1; i <= MAX_FAILED_LOGINS; i++) {
      const r = await authenticateAdmin(email, "nope");
      expect(r).toBeNull();
    }
    const row = await prisma.adminUser.findUnique({ where: { id: adminId } });
    expect(row?.failedLogins).toBe(MAX_FAILED_LOGINS);
    expect(isLocked(row?.lockedUntil)).toBe(true);

    // Correct password refused while locked.
    const blocked = await authenticateAdmin(email, PASSWORD);
    expect(blocked).toBeNull();
  });

  it("writes a login_failed audit row with the lockout reason on the trip", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await authenticateAdmin(email, "nope");
    }
    const rows = await prisma.adminAuditLog.findMany({
      where: { actorAdminId: adminId, action: "login_failed" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(rows.length).toBe(1);
    expect((rows[0].meta as Record<string, unknown>).reason).toBe(
      "wrong_password_now_locked"
    );
  });
});
