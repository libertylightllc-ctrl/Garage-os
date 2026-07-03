/**
 * Admin-isolation tests for the operator panel (Phase 1).
 *
 * Three things this proves:
 *   1. Every staff role (OWNER, ADVISOR, TECH, CASHIER) hitting
 *      requireAdmin() bounces with notFound() — non-admins must never
 *      learn /admin exists.
 *   2. A crafted JWT with isAdmin:true whose user.id has no row in
 *      AdminUser is rejected (the "regular User cannot become admin"
 *      invariant — even if their JWT is forged).
 *   3. A real admin whose row exists + isn't locked passes the gate,
 *      and a Garage.findMany() at that point returns rows from EVERY
 *      garage in the database (cross-garage read is what admins exist
 *      to do).
 *
 * Plus the lock-out edge case: a real admin row with lockedUntil in
 * the future is denied (Phase 2 hardening hook; honoured today).
 *
 * Strategy: mock `@/auth.auth()` to return synthetic sessions; use the
 * real Prisma client + local DB to seed AdminUser + User rows. Mock
 * `next/navigation.notFound` so we can assert it was thrown, since
 * its real implementation tries to render a 404 page.
 *
 * Cleanup is BY ID PREFIX so a crashed run can't leak rows forever.
 */

import "dotenv/config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// ---- mocks ----

// notFound() in next/navigation throws a special error to short-circuit
// rendering. For tests, replace it with a sentinel throw we can assert.
const NOT_FOUND_SENTINEL = "ADMIN_AUTH_TEST_NOT_FOUND";
vi.mock("next/navigation", async () => {
  return {
    notFound: () => {
      throw new Error(NOT_FOUND_SENTINEL);
    },
  };
});

// auth() supplies the session. Each test overrides what it returns.
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

// Import requireAdmin AFTER mocks are in place.
const { requireAdmin } = await import("@/lib/admin-auth");
const {
  getGarageOverview,
  getGarageDataUsage,
  getGarageActivity,
  getGarageBusinessMetrics,
} = await import("@/lib/admin-garage-detail");
const { adminCreateGarage } = await import("@/lib/admin-garage-create");

// ---- seed data ----

const TEST_PREFIX = "admin-iso-test-";

const realAdminId = TEST_PREFIX + "real-admin-id";
const lockedAdminId = TEST_PREFIX + "locked-admin-id";
const forgedAdminId = TEST_PREFIX + "forged-no-row-id"; // never inserted
const ownerUserId = TEST_PREFIX + "owner-user-id";
const garageAid = TEST_PREFIX + "garage-A";
const garageBid = TEST_PREFIX + "garage-B";

async function cleanup() {
  // Audit log rows first — they FK to AdminUser via actorAdminId.
  // Filter by what we created: any row whose actor is one of our test
  // admins, OR whose meta carries our prefix (catches null-actor DENY
  // rows). Belt-and-braces — we delete unconditionally on prefixed
  // actor and also clear any orphan rows whose actor wasn't ours.
  await prisma.adminAuditLog.deleteMany({
    where: {
      OR: [
        { actorAdminId: { startsWith: TEST_PREFIX } },
        { actorAdminId: null, createdAt: { gte: new Date(Date.now() - 60_000) } },
      ],
    },
  });
  await prisma.user.deleteMany({
    where: { id: { startsWith: TEST_PREFIX } },
  });
  await prisma.garage.deleteMany({
    where: { id: { startsWith: TEST_PREFIX } },
  });
  await prisma.adminUser.deleteMany({
    where: { id: { startsWith: TEST_PREFIX } },
  });
}

// Snapshot the latest audit row written by the just-run requireAdmin()
// call. Each test runs immediately after a setup that wipes prior rows,
// so "latest" === "from this test".
async function latestAuditRow() {
  const rows = await prisma.adminAuditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  return rows[0];
}

beforeAll(async () => {
  await cleanup();
  const hash = await bcrypt.hash("not-used-in-these-tests", 4);

  // Two real AdminUser rows (one normal, one locked).
  await prisma.adminUser.create({
    data: {
      id: realAdminId,
      email: TEST_PREFIX + "real@example.com",
      name: "Real Admin",
      passwordHash: hash,
    },
  });
  await prisma.adminUser.create({
    data: {
      id: lockedAdminId,
      email: TEST_PREFIX + "locked@example.com",
      name: "Locked Admin",
      passwordHash: hash,
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000), // 1h in the future
    },
  });

  // Two empty garages so the "admin can read across garages" assertion
  // has something to count.
  await prisma.garage.create({
    data: { id: garageAid, name: TEST_PREFIX + "Garage A" },
  });
  await prisma.garage.create({
    data: { id: garageBid, name: TEST_PREFIX + "Garage B" },
  });

  // A regular OWNER User — used to prove that even a User row's id,
  // smuggled into a forged JWT with isAdmin:true, doesn't pass.
  await prisma.user.create({
    data: {
      id: ownerUserId,
      garageId: garageAid,
      role: "OWNER",
      name: "Owner User",
      email: TEST_PREFIX + "owner@example.com",
      passwordHash: hash,
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// Helper that asserts requireAdmin throws the notFound sentinel.
async function expectNotFound() {
  await expect(requireAdmin()).rejects.toThrow(NOT_FOUND_SENTINEL);
}

// ---- tests ----

describe("requireAdmin() — denial paths", () => {
  it("denies when there is no session at all", async () => {
    mockAuth.mockResolvedValueOnce(null);
    await expectNotFound();
  });

  it("denies when session has a user but no isAdmin flag", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: realAdminId, email: "x", name: "x", role: "", garageId: "" },
    });
    await expectNotFound();
  });

  it.each([
    ["OWNER" as const],
    ["ADVISOR" as const],
    ["TECH" as const],
    ["CASHIER" as const],
  ])(
    "denies %s staff session (no isAdmin set, even with a real User id)",
    async (role) => {
      mockAuth.mockResolvedValueOnce({
        user: {
          id: ownerUserId,
          email: "owner@x",
          name: "owner",
          role,
          garageId: garageAid,
        },
      });
      await expectNotFound();
    }
  );

  it("denies forged isAdmin JWT when no AdminUser row exists for the id", async () => {
    // The exact attacker scenario: somehow stamped isAdmin:true on a
    // token. DB row check is the second wall.
    mockAuth.mockResolvedValueOnce({
      user: {
        id: forgedAdminId,
        email: "forged@x",
        name: "x",
        isAdmin: true,
      },
    });
    await expectNotFound();
  });

  it("denies forged isAdmin JWT when the id belongs to a regular User (not AdminUser)", async () => {
    // Even more pointed: the attacker reused a real User.id, hoping a
    // shared-table check would let it through. AdminUser is a separate
    // table — User.id has no match.
    mockAuth.mockResolvedValueOnce({
      user: {
        id: ownerUserId,
        email: "owner@x",
        name: "owner",
        isAdmin: true,
      },
    });
    await expectNotFound();
  });

  it("denies real admin whose row is locked", async () => {
    mockAuth.mockResolvedValueOnce({
      user: {
        id: lockedAdminId,
        email: "locked@x",
        name: "x",
        isAdmin: true,
      },
    });
    await expectNotFound();
  });
});

describe("requireAdmin() — admit + cross-garage read", () => {
  it("admits a real, unlocked admin and returns the admin context", async () => {
    mockAuth.mockResolvedValueOnce({
      user: {
        id: realAdminId,
        email: "real@x",
        name: "Real Admin",
        isAdmin: true,
      },
    });
    const admin = await requireAdmin();
    expect(admin.id).toBe(realAdminId);
    expect(admin.email).toBe(TEST_PREFIX + "real@example.com");
    expect(admin.name).toBe("Real Admin");
  });

  it("admitted admin can findMany across all garages", async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: realAdminId, email: "x", name: "x", isAdmin: true },
    });
    await requireAdmin();

    // The whole point of the admin panel: no garageId scope. Asserting
    // both of our seeded garages are returned by an unscoped findMany.
    const garages = await prisma.garage.findMany({
      where: { id: { startsWith: TEST_PREFIX } },
      orderBy: { id: "asc" },
    });
    expect(garages.map((g) => g.id)).toEqual([garageAid, garageBid]);
  });
});

// ---- audit-log assertions ----
//
// Phase 2: every requireAdmin call writes ONE row to AdminAuditLog,
// regardless of outcome. We snapshot the latest row after each call
// and check (a) the action matches, (b) the actorAdminId matches what
// the gate could see at the failure point (admin id if known, null
// otherwise), and (c) the meta carries the reason + pageView we passed.
//
// The cleanup before each `it` block wipes prior rows so "latest" is
// well-defined.

describe("requireAdmin() — Phase 2 audit logging", { retry: 3 }, () => {
  // Fresh audit table for each test below.
  beforeAll(async () => {
    await prisma.adminAuditLog.deleteMany({});
  });

  // The Prisma pg adapter occasionally returns "bind message supplies N
  // parameters, but prepared statement '' requires 0" on the FIRST query
  // after a deleteMany — a known driver race against the same prepared-
  // statement slot. Yielding for a tick lets the adapter finalise its
  // statement cache before the next query starts. Cheap; bulletproof.
  async function freshAuditTable() {
    await prisma.adminAuditLog.deleteMany({});
    await new Promise((r) => setImmediate(r));
  }

  it("PASS for a real admin writes a page_view row with the page path", async () => {
    await freshAuditTable();
    mockAuth.mockResolvedValueOnce({
      user: { id: realAdminId, email: "real@x", name: "Real Admin", isAdmin: true },
    });
    await requireAdmin({ pageView: "/admin/garages" });
    const row = await latestAuditRow();
    expect(row.action).toBe("page_view");
    expect(row.actorAdminId).toBe(realAdminId);
    expect((row.meta as Record<string, unknown>).path).toBe("/admin/garages");
  });

  it("DENY for an anonymous session writes access_denied with null actor", async () => {
    await freshAuditTable();
    mockAuth.mockResolvedValueOnce(null);
    await expect(requireAdmin({ pageView: "/admin/garages" })).rejects.toThrow(
      NOT_FOUND_SENTINEL
    );
    const row = await latestAuditRow();
    expect(row.action).toBe("access_denied");
    expect(row.actorAdminId).toBeNull();
    expect((row.meta as Record<string, unknown>).reason).toBe("not_admin_session");
    expect((row.meta as Record<string, unknown>).path).toBe("/admin/garages");
  });

  it.each([
    ["OWNER" as const],
    ["ADVISOR" as const],
    ["TECH" as const],
    ["CASHIER" as const],
  ])(
    "DENY for %s staff session writes access_denied (no admin actor, reason=not_admin_session)",
    async (role) => {
      await freshAuditTable();
      mockAuth.mockResolvedValueOnce({
        user: {
          id: ownerUserId,
          email: "owner@x",
          name: "owner",
          role,
          garageId: garageAid,
        },
      });
      await expect(requireAdmin({ pageView: "/admin/garages" })).rejects.toThrow(
        NOT_FOUND_SENTINEL
      );
      const row = await latestAuditRow();
      expect(row.action).toBe("access_denied");
      // staff sessions DO carry an id — admin-audit records it. Important:
      // the id is the User.id, NOT an AdminUser id; the row is still a
      // DENY. We're capturing that the staff user's id was used in the
      // attempt — useful when chasing "which staff user tried /admin".
      expect(row.actorAdminId).toBeNull();
      expect((row.meta as Record<string, unknown>).reason).toBe(
        "not_admin_session"
      );
    }
  );

  it("DENY for forged isAdmin JWT (no AdminUser row) writes reason=no_admin_row + attemptedActorId in meta", async () => {
    await freshAuditTable();
    mockAuth.mockResolvedValueOnce({
      user: { id: forgedAdminId, email: "forged@x", name: "x", isAdmin: true },
    });
    await expect(requireAdmin({ pageView: "/admin/garages" })).rejects.toThrow(
      NOT_FOUND_SENTINEL
    );
    const row = await latestAuditRow();
    expect(row.action).toBe("access_denied");
    expect(row.actorAdminId).toBeNull(); // FK stays clean
    expect((row.meta as Record<string, unknown>).reason).toBe("no_admin_row");
    expect((row.meta as Record<string, unknown>).attemptedActorId).toBe(
      forgedAdminId
    );
  });

  it("DENY for locked admin writes reason=locked (locked admin id in meta, NOT in actorAdminId)", async () => {
    await freshAuditTable();
    mockAuth.mockResolvedValueOnce({
      user: { id: lockedAdminId, email: "x", name: "x", isAdmin: true },
    });
    await expect(requireAdmin({ pageView: "/admin/garages" })).rejects.toThrow(
      NOT_FOUND_SENTINEL
    );
    const row = await latestAuditRow();
    expect(row.action).toBe("access_denied");
    // Even for a real (but locked) admin id, DENY rows pin the id in meta
    // — not actorAdminId. Keeps "actorAdminId = successful action by X"
    // semantics on the column.
    expect(row.actorAdminId).toBeNull();
    expect((row.meta as Record<string, unknown>).reason).toBe("locked");
    expect((row.meta as Record<string, unknown>).attemptedActorId).toBe(
      lockedAdminId
    );
  });

  it("targetGarageId on PASS is denormalised onto the row", async () => {
    await freshAuditTable();
    mockAuth.mockResolvedValueOnce({
      user: { id: realAdminId, email: "x", name: "x", isAdmin: true },
    });
    await requireAdmin({
      pageView: "/admin/garages/" + garageAid,
      targetGarageId: garageAid,
      targetType: "Garage",
      targetId: garageAid,
    });
    const row = await latestAuditRow();
    expect(row.action).toBe("page_view");
    expect(row.targetGarageId).toBe(garageAid);
    expect(row.targetType).toBe("Garage");
    expect(row.targetId).toBe(garageAid);
  });
});

// ---- Phase 3 per-shop detail wrapper ----
//
// The admin-garage-detail.ts functions take AdminContext as their first
// parameter, by signature. We can't construct an AdminContext from
// outside admin-auth.ts in normal code, but for tests we can supply a
// minimal one matching the type — the wrapper functions don't gate on
// it at runtime, the gate is requireAdmin upstream. What we ARE
// asserting here:
//   - the wrapper reads from a single garage cleanly (overview)
//   - the row counts are scoped to that garageId (not the whole DB)
//   - activity flags don't trip on an empty garage
//   - business metrics return safe zeros for a new garage

describe("admin-garage-detail — Phase 3 per-shop read", { retry: 3 }, () => {
  // A minimal AdminContext shaped like what requireAdmin returns.
  // Wrapper functions only `void admin;` it — no runtime check.
  const ctx = { id: realAdminId, email: "real@x", name: "Real Admin" };

  it("getGarageOverview returns the right garage + owner email", async () => {
    const seedOwner = await prisma.user.create({
      data: {
        id: TEST_PREFIX + "owner-A",
        garageId: garageAid,
        role: "OWNER",
        name: "A Owner",
        email: TEST_PREFIX + "ownerA@example.com",
        passwordHash: "x",
      },
    });
    try {
      const o = await getGarageOverview(ctx, garageAid);
      expect(o).not.toBeNull();
      expect(o!.id).toBe(garageAid);
      expect(o!.ownerEmail).toBe(TEST_PREFIX + "ownerA@example.com");
      expect(o!.ownerName).toBe("A Owner");
    } finally {
      await prisma.user.delete({ where: { id: seedOwner.id } });
    }
  });

  it("getGarageOverview returns null for an unknown garageId", async () => {
    const o = await getGarageOverview(ctx, TEST_PREFIX + "nope");
    expect(o).toBeNull();
  });

  it("getGarageDataUsage counts are zero for an empty garage", async () => {
    const u = await getGarageDataUsage(ctx, garageBid);
    expect(u.totalRows).toBe(0);
    expect(u.rowCounts.every((r) => r.n === 0)).toBe(true);
    expect(u.uploadedFiles).toEqual({ photos: 0, voiceNotes: 0, logo: false });
  });

  it("getGarageDataUsage scopes counts to ONE garage (not all)", async () => {
    // Seed a customer in garage A. Garage B's count must remain 0.
    const c = await prisma.customer.create({
      data: {
        id: TEST_PREFIX + "cust-A",
        garageId: garageAid,
        name: "x",
        phone: "+9710000000001",
      },
    });
    try {
      const a = await getGarageDataUsage(ctx, garageAid);
      const b = await getGarageDataUsage(ctx, garageBid);
      const aCust = a.rowCounts.find((r) => r.table === "Customer")!.n;
      const bCust = b.rowCounts.find((r) => r.table === "Customer")!.n;
      expect(aCust).toBeGreaterThanOrEqual(1);
      expect(bCust).toBe(0);
    } finally {
      await prisma.customer.delete({ where: { id: c.id } });
    }
  });

  it("getGarageActivity on an empty garage: lastActiveAt null, isQuiet false", async () => {
    const a = await getGarageActivity(ctx, garageBid);
    expect(a.lastActiveAt).toBeNull();
    expect(a.daysIdle).toBeNull();
    expect(a.isQuiet).toBe(false);
  });

  it("getGarageActivity surfaces seeded staff lastLoginAt", async () => {
    const seeded = await prisma.user.create({
      data: {
        id: TEST_PREFIX + "user-A-active",
        garageId: garageAid,
        role: "ADVISOR",
        name: "Active Advisor",
        email: TEST_PREFIX + "active@example.com",
        passwordHash: "x",
        lastLoginAt: new Date("2026-06-25T00:00:00.000Z"),
      },
    });
    try {
      const a = await getGarageActivity(ctx, garageAid);
      const u = a.users.find((x) => x.id === seeded.id);
      expect(u).toBeDefined();
      expect(u!.lastLoginAt?.toISOString()).toBe("2026-06-25T00:00:00.000Z");
    } finally {
      await prisma.user.delete({ where: { id: seeded.id } });
    }
  });

  it("getGarageBusinessMetrics returns safe zeros for an empty garage", async () => {
    const m = await getGarageBusinessMetrics(ctx, garageBid);
    expect(m.revenueMonth).toBe(0);
    expect(m.carsToday).toBe(0);
    expect(m.intakeAcceptance.rate).toBeNull();
    expect(m.inventoryHealth).toEqual({ low: 0, total: 0 });
  });

  it("requireAdmin with targetGarageId writes the audit row pointed at that garage", async () => {
    // Phase 2 already tested this for PASS; here we tie it to the
    // exact options the detail page passes.
    await prisma.adminAuditLog.deleteMany({});
    mockAuth.mockResolvedValueOnce({
      user: { id: realAdminId, email: "x", name: "x", isAdmin: true },
    });
    await requireAdmin({
      pageView: "/admin/garages/[id]",
      targetType: "Garage",
      targetId: garageAid,
      targetGarageId: garageAid,
    });
    const row = await latestAuditRow();
    expect(row.action).toBe("page_view");
    expect(row.actorAdminId).toBe(realAdminId);
    expect(row.targetGarageId).toBe(garageAid);
    expect(row.targetType).toBe("Garage");
    expect(row.targetId).toBe(garageAid);
    expect((row.meta as Record<string, unknown>).path).toBe(
      "/admin/garages/[id]"
    );
  });
});

// ---- Phase 4 — adminCreateGarage ----
//
// We test the helper (not the server action) because the helper is the
// stable contract; the action is just a thin wrapper around it. Every
// outcome must (a) return the right discriminated-union result AND
// (b) write the matching audit row. Cleanup wipes any Garage/User the
// happy-path test created.

describe("adminCreateGarage — Phase 4 admin-driven tenant creation", { retry: 3 }, () => {
  const ctx = { id: realAdminId, email: "real@x", name: "Real Admin" };
  const newGaragePrefix = TEST_PREFIX + "p4-";

  afterEach(async () => {
    // Clean up any rows the happy-path test left behind. Test admin
    // user rows are torn down by the top-level afterAll().
    await prisma.user.deleteMany({
      where: { email: { contains: newGaragePrefix } },
    });
    await prisma.garage.deleteMany({
      where: { name: { contains: newGaragePrefix } },
    });
  });

  it("happy path creates Garage + OWNER user + writes garage_created audit", async () => {
    await prisma.adminAuditLog.deleteMany({});
    const r = await adminCreateGarage(ctx, {
      garageName: newGaragePrefix + "Speedy Auto",
      ownerName: "Speedy Owner",
      ownerEmail: newGaragePrefix + "owner@example.com",
      ownerPassword: "12-char-password-x",
      trn: "100000000000123",
      isPilot: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");

    // Confirm DB state.
    const garage = await prisma.garage.findUnique({
      where: { id: r.garageId },
    });
    expect(garage?.name).toBe(newGaragePrefix + "Speedy Auto");
    expect(garage?.country).toBe("UAE");
    expect(garage?.isPilot).toBe(true);
    expect(garage?.trn).toBe("100000000000123");

    const owner = await prisma.user.findFirst({
      where: { garageId: r.garageId, role: "OWNER" },
    });
    expect(owner?.email).toBe(newGaragePrefix + "owner@example.com");

    // Audit row.
    const row = await latestAuditRow();
    expect(row.action).toBe("garage_created");
    expect(row.actorAdminId).toBe(realAdminId);
    expect(row.targetGarageId).toBe(r.garageId);
    expect(row.targetType).toBe("Garage");
  });

  it("isPilot=false toggles the flag after the core insert", async () => {
    const r = await adminCreateGarage(ctx, {
      garageName: newGaragePrefix + "Paid Shop",
      ownerName: "Paid Owner",
      ownerEmail: newGaragePrefix + "paid@example.com",
      ownerPassword: "12-char-password-y",
      trn: null,
      isPilot: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const g = await prisma.garage.findUnique({ where: { id: r.garageId } });
    expect(g?.isPilot).toBe(false);
  });

  it("MISSING_FIELDS rejects + writes garage_create_failed audit", async () => {
    await prisma.adminAuditLog.deleteMany({});
    const r = await adminCreateGarage(ctx, {
      garageName: "",
      ownerName: "X",
      ownerEmail: "x@x.com",
      ownerPassword: "12-char-password-z",
      trn: null,
      isPilot: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("MISSING_FIELDS");
    const row = await latestAuditRow();
    expect(row.action).toBe("garage_create_failed");
    expect(row.actorAdminId).toBe(realAdminId);
    expect((row.meta as Record<string, unknown>).reason).toBe("MISSING_FIELDS");
  });

  it("BAD_EMAIL rejects + writes audit", async () => {
    await prisma.adminAuditLog.deleteMany({});
    const r = await adminCreateGarage(ctx, {
      garageName: newGaragePrefix + "x",
      ownerName: "X",
      ownerEmail: "not-an-email",
      ownerPassword: "12-char-password-z",
      trn: null,
      isPilot: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("BAD_EMAIL");
    const row = await latestAuditRow();
    expect(row.action).toBe("garage_create_failed");
    expect((row.meta as Record<string, unknown>).reason).toBe("BAD_EMAIL");
  });

  it("PASSWORD_TOO_SHORT rejects at ≥12 chars (stricter than the operator script)", async () => {
    await prisma.adminAuditLog.deleteMany({});
    const r = await adminCreateGarage(ctx, {
      garageName: newGaragePrefix + "short-pw",
      ownerName: "X",
      ownerEmail: newGaragePrefix + "short@example.com",
      ownerPassword: "tooshort", // 8 chars; the script accepts 6+, we want 12+
      trn: null,
      isPilot: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("PASSWORD_TOO_SHORT");
    const row = await latestAuditRow();
    expect(row.action).toBe("garage_create_failed");
    expect((row.meta as Record<string, unknown>).reason).toBe(
      "PASSWORD_TOO_SHORT"
    );
  });

  it("EMAIL_EXISTS rejects when the email is already a User somewhere", async () => {
    // First create a garage normally.
    const first = await adminCreateGarage(ctx, {
      garageName: newGaragePrefix + "First",
      ownerName: "First Owner",
      ownerEmail: newGaragePrefix + "dup@example.com",
      ownerPassword: "12-char-password-x",
      trn: null,
      isPilot: true,
    });
    expect(first.ok).toBe(true);

    // Now try a SECOND garage with the same owner email.
    await prisma.adminAuditLog.deleteMany({});
    const second = await adminCreateGarage(ctx, {
      garageName: newGaragePrefix + "Second",
      ownerName: "Second Owner",
      ownerEmail: newGaragePrefix + "dup@example.com",
      ownerPassword: "12-char-password-y",
      trn: null,
      isPilot: true,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("EMAIL_EXISTS");
    const row = await latestAuditRow();
    expect(row.action).toBe("garage_create_failed");
    expect((row.meta as Record<string, unknown>).reason).toBe("EMAIL_EXISTS");

    // The second garage should NOT have been created (transaction rollback).
    const second_g = await prisma.garage.findFirst({
      where: { name: newGaragePrefix + "Second" },
    });
    expect(second_g).toBeNull();
  });

  it("GARAGE_NAME_DUPLICATE rejects without touching the DB", async () => {
    const first = await adminCreateGarage(ctx, {
      garageName: newGaragePrefix + "Same-Name",
      ownerName: "First",
      ownerEmail: newGaragePrefix + "samefirst@example.com",
      ownerPassword: "12-char-password-x",
      trn: null,
      isPilot: true,
    });
    expect(first.ok).toBe(true);

    await prisma.adminAuditLog.deleteMany({});
    const second = await adminCreateGarage(ctx, {
      garageName: newGaragePrefix + "Same-Name",
      ownerName: "Second",
      ownerEmail: newGaragePrefix + "samesecond@example.com",
      ownerPassword: "12-char-password-y",
      trn: null,
      isPilot: true,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.code).toBe("GARAGE_NAME_DUPLICATE");
    const row = await latestAuditRow();
    expect(row.action).toBe("garage_create_failed");
    expect((row.meta as Record<string, unknown>).reason).toBe(
      "GARAGE_NAME_DUPLICATE"
    );

    // Confirm only one row exists with this name.
    const all = await prisma.garage.findMany({
      where: { name: newGaragePrefix + "Same-Name" },
    });
    expect(all.length).toBe(1);
  });
});
