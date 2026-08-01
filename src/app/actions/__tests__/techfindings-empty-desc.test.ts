/**
 * Regression test for prod digest 1013687292: submitting the tech
 * "add part" form with an empty description used to throw
 * `Error("A part description is required.")`, which surfaced as
 * a generic "Something went wrong" page and 500 in the logs.
 *
 * The fix: return silently on empty description. The client form
 * has `required` on the description input so the browser blocks
 * the submit first — this test covers the belt-and-braces server
 * path (JS off / DOM edited / curl).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        throw new Error("REDIRECT:" + url);
    },
}));

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

// Mock every prisma model this test touches. jobPart.create MUST NOT
// be called for the empty-description path — that's the assertion.
//
// `user.count` is mocked to `1` so the sessionUserExists guard added
// in commit 5e2ed5b4 ("Guard: reject stale JWT before it reaches the
// DB writes") sees a live user and returns true. Before this fix the
// mock lacked `user`, so `prisma.user.count` was undefined and every
// test in this file threw `Cannot read properties of undefined
// (reading 'count')` at src/lib/session-user.ts:28 — that was the
// single failure keeping CI red on main since 2026-07-27.
const jobCardFindFirst = vi.fn();
const partFindFirst = vi.fn();
const jobPartCreate = vi.fn();
const userCount = vi.fn().mockResolvedValue(1);

vi.mock("@/lib/prisma", () => ({
    prisma: {
        jobCard: { findFirst: (...a: unknown[]) => jobCardFindFirst(...a) },
        part: { findFirst: (...a: unknown[]) => partFindFirst(...a) },
        jobPart: { create: (...a: unknown[]) => jobPartCreate(...a) },
        user: { count: (...a: unknown[]) => userCount(...a) },
    },
}));

const { addRequiredPartAction, addUsedPartAction } = await import(
    "@/app/actions/techfindings"
);

function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
}

describe("techfindings: empty description does not crash (digest 1013687292 regression)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuth.mockResolvedValue({
            user: { id: "u-tech", role: "TECH", garageId: "g-1" },
        });
        jobCardFindFirst.mockResolvedValue({
            id: "j-1",
            status: "INSPECTION",
            claimedById: "u-tech",
            helpers: [],
        });
        partFindFirst.mockResolvedValue(null);
    });

    it("addRequiredPartAction: empty description + no partId → returns without throwing, creates nothing", async () => {
        await expect(
            addRequiredPartAction(
                form({ jobId: "j-1", partId: "", partNo: "", description: "", qty: "1" }),
            ),
        ).resolves.toBeUndefined();
        expect(jobPartCreate).not.toHaveBeenCalled();
    });

    it("addRequiredPartAction: empty description with partId whose lookup returns null → returns cleanly, creates nothing", async () => {
        await expect(
            addRequiredPartAction(
                form({
                    jobId: "j-1",
                    partId: "p-missing",
                    partNo: "",
                    description: "",
                    qty: "1",
                }),
            ),
        ).resolves.toBeUndefined();
        expect(jobPartCreate).not.toHaveBeenCalled();
    });

    it("addRequiredPartAction: description present → still creates the JobPart (no regression)", async () => {
        jobPartCreate.mockResolvedValue({ id: "jp-1" });
        await addRequiredPartAction(
            form({
                jobId: "j-1",
                partId: "",
                partNo: "",
                description: "AC compressor",
                qty: "1",
            }),
        );
        expect(jobPartCreate).toHaveBeenCalledOnce();
    });

    it("addUsedPartAction: empty description + no partId → returns without throwing, creates nothing", async () => {
        // addUsedPartAction requires REPAIR-open job; mock accordingly.
        jobCardFindFirst.mockResolvedValue({
            id: "j-1",
            status: "REPAIR",
            claimedById: "u-tech",
            helpers: [],
        });
        await expect(
            addUsedPartAction(
                form({ jobId: "j-1", partId: "", partNo: "", description: "", qty: "1" }),
            ),
        ).resolves.toBeUndefined();
        expect(jobPartCreate).not.toHaveBeenCalled();
    });
});
