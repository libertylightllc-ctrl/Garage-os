import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Write an AiEvent row without letting the operation that emits it crash.
 *
 * Telemetry writes must never take down the real work — see
 * `docs/telemetry-must-not-crash-operation-spec.md`. The concrete bug
 * that filed this: an intake POST 500'd because the AiEvent insert hit
 * a stale-JWT FK violation. The Moulkia OCR itself had succeeded; we
 * threw the whole check-in away because we couldn't log the metadata.
 *
 * Contract:
 *   - Returns Promise<void> and NEVER throws.
 *   - On success: the AiEvent row is written.
 *   - On any failure (FK violation, DB disconnect, unique constraint,
 *     validation): a warning is logged to stderr and the promise still
 *     resolves. The caller CANNOT distinguish success from failure —
 *     that's the point. The caller isn't allowed to react to log
 *     failures, because reacting means taking down the operation.
 *
 * If you find yourself wanting to know whether the log succeeded, you
 * are trying to route logic through telemetry. Don't. Add a separate
 * write on the operational path.
 */
export async function safeLogAiEvent(
    data: Prisma.AiEventUncheckedCreateInput,
): Promise<void> {
    try {
        await prisma.aiEvent.create({ data });
    } catch (err) {
        // Best-effort — never crash the caller. Log to stderr so
        // pipeline dashboards can still count the drops. `console.warn`
        // ends up in Vercel's function logs; not visible to users.
        console.warn("[safeLogAiEvent] insert failed, dropping row", {
            kind: data.kind,
            garageId: data.garageId,
            userId: data.userId ?? null,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}
