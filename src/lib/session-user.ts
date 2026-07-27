import { cache } from "react";
import { prisma } from "@/lib/prisma";

/**
 * Verify the JWT's user id still resolves to a real User row.
 *
 * Both guard modules (`action-guards.ts`, `guard.ts`) trusted the JWT's
 * `session.user.id` at face value. That fails after any operation that
 * rotates the user's row: a hand-run reseed in dev, an admin
 * hard-delete in prod, a garage migration that recreates staff. The
 * old JWT still passes `auth()`, but every downstream FK write
 * (`AiEvent.userId`, `JobCard.advisorId`, `WhatsAppMessage.userId`,
 * …) P2003's on the missing user and the user-facing action 500's.
 *
 * The fix at the write site (catch-and-swallow) is only correct for
 * telemetry writes — see `docs/telemetry-must-not-crash-operation-spec.md`.
 * An operational write like `JobCard.advisorId` CANNOT be swallowed;
 * the JobCard genuinely needs to record who created it.
 *
 * So we check at the guard, once per request:
 *   - user exists → proceed
 *   - user missing → redirect to /login (in the caller)
 *
 * `cache()` dedupes the DB round-trip when the same request has
 * multiple guard calls (a page guard + several actions).
 */
export const sessionUserExists = cache(async (userId: string): Promise<boolean> => {
    const n = await prisma.user.count({ where: { id: userId } });
    return n > 0;
});
