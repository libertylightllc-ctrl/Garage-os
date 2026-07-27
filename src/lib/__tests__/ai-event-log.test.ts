/**
 * Pins the invariant that the telemetry-must-not-crash-operation spec
 * exists to enforce: `safeLogAiEvent` NEVER throws. If the underlying
 * `prisma.aiEvent.create` fails — FK violation, DB disconnect,
 * validation, anything — the caller keeps running.
 *
 * The concrete bug that filed this: a stale JWT caused
 * `intake-moulkia.ts:logAttempts` to hit `AiEvent_userId_fkey` (P2003),
 * which took down the entire intake POST. The OCR itself had
 * succeeded; we threw the check-in away because we couldn't log the
 * metadata.
 *
 * If a future refactor removes the try/catch inside `safeLogAiEvent`,
 * these tests turn red loudly.
 *
 * See docs/telemetry-must-not-crash-operation-spec.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const aiEventCreate = vi.fn();

vi.mock("@/lib/prisma", () => ({
    prisma: {
        aiEvent: { create: (...a: unknown[]) => aiEventCreate(...a) },
    },
}));

const { safeLogAiEvent } = await import("@/lib/ai-event-log");

const baseData = {
    garageId: "g-1",
    userId: "u-1",
    kind: "OCR" as const,
    model: "claude-fake",
    sourceType: "MOULKIA_FRONT",
    tokensIn: 100,
    tokensOut: 50,
    costEstimate: 0.001,
    latencyMs: 750,
};

describe("safeLogAiEvent — telemetry must not crash the operation", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        // Silence + capture the best-effort warn. Restored in afterEach.
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it("passes the row through to prisma on the happy path", async () => {
        aiEventCreate.mockResolvedValue({ id: "ev-1" });
        await expect(safeLogAiEvent(baseData)).resolves.toBeUndefined();
        expect(aiEventCreate).toHaveBeenCalledOnce();
        expect(aiEventCreate.mock.calls[0][0]).toEqual({ data: baseData });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does NOT throw on P2003 FK violation (the intake bug)", async () => {
        // Mirror the actual error we saw in production: digest 4090316057,
        // Prisma P2003 on AiEvent_userId_fkey. Stale JWT scenario.
        const fkErr = Object.assign(
            new Error("Foreign key constraint violated: AiEvent_userId_fkey"),
            { code: "P2003" },
        );
        aiEventCreate.mockRejectedValue(fkErr);

        await expect(safeLogAiEvent(baseData)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledOnce();
        // The warn should carry enough context to diagnose without the
        // full row (which may include user PII).
        const call = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(call[0]).toContain("safeLogAiEvent");
        expect(call[1]).toMatchObject({
            kind: "OCR",
            garageId: "g-1",
            userId: "u-1",
        });
        expect(String(call[1].err)).toContain("Foreign key");
    });

    it("does NOT throw on a generic DB failure (connection dropped)", async () => {
        aiEventCreate.mockRejectedValue(new Error("Server has closed the connection."));
        await expect(safeLogAiEvent(baseData)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("does NOT throw when prisma rejects with a non-Error value", async () => {
        // Belt-and-braces: some drivers throw strings, some throw objects.
        // The helper must survive any thrown value.
        aiEventCreate.mockRejectedValue("boom");
        await expect(safeLogAiEvent(baseData)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledOnce();
        const call = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(call[1].err).toBe("boom");
    });

    it("survives a null userId (receptionist / anonymous webhook path)", async () => {
        aiEventCreate.mockRejectedValue(new Error("some failure"));
        await expect(
            safeLogAiEvent({ ...baseData, userId: null }),
        ).resolves.toBeUndefined();
        const call = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(call[1].userId).toBeNull();
    });
});
