/**
 * Pin test for AR's "F" adjustment on Estimate → PO auto-create:
 *
 *   "back-fill approved, but STRICTLY partId only. Never write
 *    description, unitPrice, qty, or any other field on an approved
 *    EstimateLine. The customer signed off on that text and that
 *    price; linking it to a catalog row is bookkeeping, changing
 *    what they agreed to is not."
 *
 * The action creates catalog Parts from free-text estimate lines and
 * then back-fills `partId` on the EstimateLine. Only that one column.
 * If a future refactor accidentally starts writing description /
 * unitPrice / qty on the line, this test fails and the reviewer sees
 * why they're not allowed to.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        throw new Error("REDIRECT:" + url);
    },
}));

vi.mock("@/lib/action-guards", () => ({
    requireOperational: async () => ({
        id: "u-owner",
        role: "OWNER",
        garageId: "g-1",
    }),
}));

const jobCardFindFirst = vi.fn();
const estimateFindFirst = vi.fn();
const partFindMany = vi.fn();
const txPartFindFirst = vi.fn();
const txPartCreate = vi.fn();
const txEstimateLineUpdate = vi.fn();
const runTransaction = vi.fn();

vi.mock("@/lib/prisma", () => ({
    prisma: {
        jobCard: { findFirst: (...a: unknown[]) => jobCardFindFirst(...a) },
        estimate: { findFirst: (...a: unknown[]) => estimateFindFirst(...a) },
        part: { findMany: (...a: unknown[]) => partFindMany(...a) },
        $transaction: (fn: (tx: unknown) => Promise<void>) => {
            runTransaction(fn);
            return fn({
                part: {
                    findFirst: (...a: unknown[]) => txPartFindFirst(...a),
                    create: (...a: unknown[]) => txPartCreate(...a),
                },
                estimateLine: {
                    update: (...a: unknown[]) => txEstimateLineUpdate(...a),
                },
            });
        },
    },
}));

const { autoCreatePartsFromEstimateLinesAction } = await import(
    "@/app/actions/purchasing"
);

function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
}

const jobCard = { id: "jc-1", number: 42 };
const linePart = {
    id: "el-1",
    kind: "PART" as const,
    partId: null as string | null,
    description: "Front brake pads (OEM)",
    unitPrice: "180.00",
    declined: false,
};

describe("autoCreatePartsFromEstimateLinesAction: only back-fills partId (AR rule F)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        jobCardFindFirst.mockResolvedValue({ number: jobCard.number });
        estimateFindFirst.mockResolvedValue({
            id: "est-1",
            jobCard: { id: jobCard.id },
            lines: [linePart],
        });
        partFindMany.mockResolvedValue([]);
        txPartCreate.mockResolvedValue({ id: "new-part-id" });
        txPartFindFirst.mockResolvedValue(null);
    });

    it("create-new path: estimateLine.update is called with { partId } ONLY — no description/unitPrice/qty writes", async () => {
        await expect(
            autoCreatePartsFromEstimateLinesAction(
                form({
                    jobCardId: jobCard.id,
                    estimateId: "est-1",
                    "sku_el-1": "BRK-PAD-F",
                    "name_el-1": "Front brake pads",
                    "cost_el-1": "0",
                    "price_el-1": "200.00",
                }),
            ),
        ).rejects.toThrow(/^REDIRECT:/);

        expect(txEstimateLineUpdate).toHaveBeenCalledOnce();
        const call = txEstimateLineUpdate.mock.calls[0][0] as {
            where: { id: string };
            data: Record<string, unknown>;
        };
        expect(call.where).toEqual({ id: "el-1" });
        expect(Object.keys(call.data)).toEqual(["partId"]);
        expect(call.data.partId).toBe("new-part-id");
        for (const forbidden of [
            "description",
            "unitPrice",
            "qty",
            "declined",
            "kind",
        ]) {
            expect(call.data).not.toHaveProperty(forbidden);
        }
    });

    it("link-to-existing path: estimateLine.update is still { partId } ONLY", async () => {
        txPartFindFirst.mockResolvedValue({ id: "existing-part-99" });

        await expect(
            autoCreatePartsFromEstimateLinesAction(
                form({
                    jobCardId: jobCard.id,
                    estimateId: "est-1",
                    "linkTo_el-1": "existing-part-99",
                    "sku_el-1": "ignored-because-linking",
                    "name_el-1": "ignored-because-linking",
                    "cost_el-1": "99",
                    "price_el-1": "99",
                }),
            ),
        ).rejects.toThrow(/^REDIRECT:/);

        expect(txPartCreate).not.toHaveBeenCalled();
        expect(txEstimateLineUpdate).toHaveBeenCalledOnce();
        const call = txEstimateLineUpdate.mock.calls[0][0] as {
            where: { id: string };
            data: Record<string, unknown>;
        };
        expect(Object.keys(call.data)).toEqual(["partId"]);
        expect(call.data.partId).toBe("existing-part-99");
    });

    it("declined line: never seen — no Part created, no line update", async () => {
        estimateFindFirst.mockResolvedValue({
            id: "est-1",
            jobCard: { id: jobCard.id },
            lines: [{ ...linePart, declined: true }],
        });
        await expect(
            autoCreatePartsFromEstimateLinesAction(
                form({ jobCardId: jobCard.id, estimateId: "est-1" }),
            ),
        ).rejects.toThrow(/^REDIRECT:/);
        expect(txPartCreate).not.toHaveBeenCalled();
        expect(txEstimateLineUpdate).not.toHaveBeenCalled();
    });

    it("line that already has partId: skipped — nothing back-filled", async () => {
        estimateFindFirst.mockResolvedValue({
            id: "est-1",
            jobCard: { id: jobCard.id },
            lines: [{ ...linePart, partId: "already-linked" }],
        });
        await expect(
            autoCreatePartsFromEstimateLinesAction(
                form({ jobCardId: jobCard.id, estimateId: "est-1" }),
            ),
        ).rejects.toThrow(/^REDIRECT:/);
        expect(txPartCreate).not.toHaveBeenCalled();
        expect(txEstimateLineUpdate).not.toHaveBeenCalled();
    });
});
