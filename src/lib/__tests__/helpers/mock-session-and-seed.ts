import { prisma } from "@/lib/prisma";
import type { Role } from "@/generated/prisma/enums";

/**
 * Test helper: seed a User row that matches the session about to be
 * mocked into `auth()`, so `requireAnyRole`'s `sessionUserExists`
 * guard finds it and the test exercises the intended code path.
 *
 * Before commit 5e2ed5b4 added the guard, isolation tests could fake
 * a session object with any user id — the tests never inserted the
 * matching User row and the guard didn't check. After the guard, any
 * such test now redirects to /login before the action runs. The
 * tests weren't wrong about what they were exercising; they were
 * asserting against an impossible production state.
 *
 * Usage:
 *
 *   const session = await mockSessionAndSeed({
 *     id: TEST_PREFIX + "u",
 *     garageId: garageA,
 *     role: "OWNER",
 *   });
 *   mockAuth.mockResolvedValueOnce(session);
 *
 * Every test file that uses this MUST clean up its User rows in the
 * suite's `cleanup()` — usually by extending the garageId-prefix
 * delete already present:
 *
 *   await prisma.user.deleteMany({
 *     where: { garageId: { startsWith: TEST_PREFIX } },
 *   });
 *
 * Idempotent — repeated calls with the same id update the row rather
 * than throwing on the primary key.
 */
export interface SeedOptions {
    id: string;
    garageId: string;
    role: string;
    email?: string;
    name?: string;
    /**
     * Extra fields the caller wants on the session object (e.g.
     * `isAdmin: true` on the AdminUser paths). Merged verbatim into
     * the returned `.user` object; NOT written to the User row.
     */
    extraSessionFields?: Record<string, unknown>;
}

interface Session {
    user: {
        id: string;
        role: string;
        garageId: string;
        email: string;
        name: string;
        [k: string]: unknown;
    };
}

export async function mockSessionAndSeed(opts: SeedOptions): Promise<Session> {
    const email = opts.email ?? `${opts.id}@test.local`;
    const name = opts.name ?? "test-user";

    // Upsert on id so the same helper can be called multiple times
    // for the same fixture user in a single test without racing.
    await prisma.user.upsert({
        where: { id: opts.id },
        update: {
            garageId: opts.garageId,
            role: opts.role as Role,
            email,
            name,
        },
        create: {
            id: opts.id,
            garageId: opts.garageId,
            role: opts.role as Role,
            email,
            name,
            passwordHash: "test-fixture-not-a-real-hash",
        },
    });

    return {
        user: {
            id: opts.id,
            role: opts.role,
            garageId: opts.garageId,
            email,
            name,
            ...opts.extraSessionFields,
        },
    };
}
