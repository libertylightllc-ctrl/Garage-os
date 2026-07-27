/**
 * Pins the invariant that a stale JWT (auth cookie valid, but its
 * `sub` no longer references a real User row) is caught at the guard
 * boundary, not deep in a downstream FK write.
 *
 * Concrete bugs this replaces:
 *   - digest 4090316057 — intake POST crashed on AiEvent_userId_fkey
 *   - digest 4081260019 — intake POST crashed on JobCard_advisorId_fkey
 *
 * Both were the SAME root cause: `auth()` returned a valid session
 * for a stale JWT, and the write path took down the whole action.
 * The fix (`src/lib/session-user.ts`) makes both guards verify the
 * user still exists; if not, they redirect to /login.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.fn();
const userCount = vi.fn();
const redirectMock = vi.fn((path: string) => {
    throw new Error("REDIRECT:" + path);
});

vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("next/navigation", () => ({ redirect: (p: string) => redirectMock(p) }));
vi.mock("@/lib/prisma", () => ({
    prisma: { user: { count: (...a: unknown[]) => userCount(...a) } },
}));

// The guards import sessionUserExists indirectly via prisma.user.count.
// React's cache() memoizes per-request; in tests we run each `it` fresh.
const { requireAnyRole: requireAnyRoleAction } = await import(
    "@/lib/action-guards"
);
const { requireAnyRole: requireAnyRolePage, requireRole } = await import(
    "@/lib/guard"
);

beforeEach(() => {
    vi.clearAllMocks();
});

describe("action-guards.requireAnyRole — stale JWT rejected", () => {
    it("live user: returns the session user", async () => {
        authMock.mockResolvedValue({
            user: { id: "u-live", role: "ADVISOR", garageId: "g-1" },
        });
        userCount.mockResolvedValue(1);
        const u = await requireAnyRoleAction(["ADVISOR"]);
        expect(u.id).toBe("u-live");
        expect(userCount).toHaveBeenCalledWith({ where: { id: "u-live" } });
    });

    it("stale JWT (user gone): redirects to /login instead of returning", async () => {
        authMock.mockResolvedValue({
            user: { id: "u-gone", role: "ADVISOR", garageId: "g-1" },
        });
        userCount.mockResolvedValue(0);
        await expect(requireAnyRoleAction(["ADVISOR"])).rejects.toThrow(
            "REDIRECT:/login",
        );
    });

    it("wrong role: still throws Not authorized (existing contract preserved)", async () => {
        authMock.mockResolvedValue({
            user: { id: "u-live", role: "TECH", garageId: "g-1" },
        });
        // userCount never queried — role check trips first.
        await expect(requireAnyRoleAction(["ADVISOR"])).rejects.toThrow(
            "Not authorized",
        );
        expect(userCount).not.toHaveBeenCalled();
    });

    it("no session: throws Not authorized before any DB roundtrip", async () => {
        authMock.mockResolvedValue(null);
        await expect(requireAnyRoleAction(["ADVISOR"])).rejects.toThrow(
            "Not authorized",
        );
        expect(userCount).not.toHaveBeenCalled();
    });
});

describe("guard.requireRole (page guard) — stale JWT rejected", () => {
    it("live user: returns the session", async () => {
        authMock.mockResolvedValue({
            user: { id: "u-live", role: "OWNER", garageId: "g-1" },
        });
        userCount.mockResolvedValue(1);
        const s = await requireRole("OWNER");
        expect(s.user.id).toBe("u-live");
    });

    it("stale JWT: redirects to /login", async () => {
        authMock.mockResolvedValue({
            user: { id: "u-gone", role: "OWNER", garageId: "g-1" },
        });
        userCount.mockResolvedValue(0);
        await expect(requireRole("OWNER")).rejects.toThrow("REDIRECT:/login");
    });
});

describe("guard.requireAnyRole (page guard) — stale JWT rejected", () => {
    it("stale JWT: redirects to /login", async () => {
        authMock.mockResolvedValue({
            user: { id: "u-gone", role: "OWNER", garageId: "g-1" },
        });
        userCount.mockResolvedValue(0);
        await expect(requireAnyRolePage(["OWNER", "MASTER"])).rejects.toThrow(
            "REDIRECT:/login",
        );
    });
});
