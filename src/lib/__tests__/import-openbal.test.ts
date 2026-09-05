/**
 * E7b step 2 — opening-balance import (customer AR direction).
 * AR 2026-09-03.
 *
 * Pins:
 *   PARSER
 *     1. Happy CSV → typed rows, no errors.
 *     2. Missing required column → throws (whole file unusable).
 *     3. Per-row failures (blank name, non-number balance, negative
 *        balance, bad date) surface in errors[], not rows[].
 *     4. Thousands-separator commas in Balance tolerated.
 *     5. Empty balance = 0 → skipped as error, not silently kept.
 *
 *   ACTIONS
 *     6. Preview creates DRAFT batch, no ledger writes.
 *     7. Commit posts DR AR / CR OBE per successful row, marks
 *        COMMITTED, and captures per-row errors (customer not found,
 *        ambiguous, already-imported).
 *     8. Commit refused on already-COMMITTED batch (no double-post).
 *     9. Customer already has OB → refused; per-row error captured.
 *    10. Row 400 failing does NOT roll back rows 1-399.
 *    11. Discard sets DISCARDED, no writes.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";
import { parseOpeningBalanceCsv } from "@/lib/import/parse-openbal";
import { withDeleteGuardBypass } from "@/lib/__tests__/helpers/ledger-guard-bypass";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        throw new Error("REDIRECT:" + url);
    },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-user", () => ({ sessionUserExists: async () => true }));

const { previewOpeningBalanceImportAction, commitLedgerImportBatchAction, discardLedgerImportBatchAction } = await import(
    "@/app/actions/import"
);

const P = "import-ob-test-";
const gId = P + "garage";

function owner() {
    return { user: { id: P + "u", role: "OWNER", garageId: gId, email: "x", name: "x" } };
}
function form(fields: Record<string, string | File>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
}
function csvFile(name: string, contents: string): File {
    return new File([contents], name, { type: "text/csv" });
}
async function call(action: (fd: FormData) => Promise<void>, fd: FormData): Promise<string> {
    try {
        await action(fd);
        return "(no redirect)";
    } catch (e) {
        const m = (e as Error).message;
        if (m.startsWith("REDIRECT:")) return m.slice("REDIRECT:".length);
        throw e;
    }
}

async function cleanup() {
    await withDeleteGuardBypass(prisma, async (tx) => {
        await tx.ledgerEntry.deleteMany({ where: { garageId: { startsWith: P } } });
    });
    await prisma.ledgerImportError.deleteMany({
        where: { batch: { garageId: { startsWith: P } } },
    });
    await prisma.ledgerImportBatch.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}
beforeEach(async () => {
    await cleanup();
    await prisma.garage.create({ data: { id: gId, name: gId } });
    await prisma.user.create({
        data: { id: P + "u", garageId: gId, role: "OWNER" as never, name: "OB Owner", email: P + "u@test.local" },
    });
    mockAuth.mockReset();
});
afterAll(cleanup);

describe("parseOpeningBalanceCsv — parser", () => {
    it("Happy CSV → typed rows, no errors", () => {
        const csv = "Customer,Balance,As of\nAl Falah Motors,5000.00,2026-06-01\nSameer Ahmed,1200,2026-07-15";
        const { rows, errors } = parseOpeningBalanceCsv(csv);
        expect(errors).toEqual([]);
        expect(rows).toHaveLength(2);
        expect(rows[0].customerName).toBe("Al Falah Motors");
        expect(rows[0].balance).toBe(5000);
        expect(rows[0].asOfDate.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    });

    it("Missing required column → throws (whole file unusable)", () => {
        // "Name" matches the customer alias, "Amount" matches the balance
        // alias — but As of is absent. Parser checks columns in order;
        // the first missing one throws.
        expect(() => parseOpeningBalanceCsv("Name,Amount\nX,100")).toThrow(/Missing "As of"/);
        // And an explicit missing-Balance case (no Balance alias):
        expect(() => parseOpeningBalanceCsv("Customer,As of\nX,2026-06-01")).toThrow(/Missing "Balance"/);
    });

    it("Per-row failures surface in errors[], not rows[]", () => {
        const csv = [
            "Customer,Balance,As of",
            ",100,2026-06-01",              // blank name
            "Bad Num,abc,2026-06-01",       // not a number
            "Negative,-50,2026-06-01",      // negative
            "No Date,100,",                 // missing date
            "Bad Date,100,not-a-date",      // bad date
            "Good,999,2026-06-01",          // valid
        ].join("\n");
        const { rows, errors } = parseOpeningBalanceCsv(csv);
        expect(rows).toHaveLength(1);
        expect(rows[0].customerName).toBe("Good");
        expect(errors).toHaveLength(5);
        expect(errors[0].reason).toMatch(/customer name/i);
        expect(errors[1].reason).toMatch(/not a number/i);
        expect(errors[2].reason).toMatch(/negative/i);
        expect(errors[3].reason).toMatch(/date/i);
        expect(errors[4].reason).toMatch(/not a valid date/i);
    });

    it("Thousands-separator commas in Balance tolerated", () => {
        const csv = 'Customer,Balance,As of\n"Big Debtor","12,345.67",2026-06-01';
        const { rows, errors } = parseOpeningBalanceCsv(csv);
        expect(errors).toEqual([]);
        expect(rows[0].balance).toBe(12345.67);
    });

    it("Zero balance → skipped as error, not silently kept", () => {
        const csv = "Customer,Balance,As of\nZero Guy,0,2026-06-01";
        const { rows, errors } = parseOpeningBalanceCsv(csv);
        expect(rows).toHaveLength(0);
        expect(errors[0].reason).toMatch(/zero/i);
    });
});

describe("previewOpeningBalanceImportAction", () => {
    it("Creates DRAFT batch, no ledger writes", async () => {
        await prisma.customer.create({ data: { garageId: gId, name: "Al Falah Motors", phone: "9990001" } });
        mockAuth.mockResolvedValueOnce(owner());
        const csv = "Customer,Balance,As of\nAl Falah Motors,5000,2026-06-01";
        const to = await call(previewOpeningBalanceImportAction, form({ file: csvFile("ob.csv", csv) }));
        expect(to).toMatch(/\/owner\/accounting\/import\/[a-z0-9]+/);
        const batch = await prisma.ledgerImportBatch.findFirst({ where: { garageId: gId } });
        expect(batch?.status).toBe("DRAFT");
        expect(batch?.kind).toBe("OPENING_BALANCE");
        // No ledger writes yet.
        expect(await prisma.ledgerEntry.count({ where: { garageId: gId } })).toBe(0);
    });
});

describe("commitLedgerImportBatchAction — OPENING_BALANCE", () => {
    async function seedPreviewAndReturnBatchId(csv: string) {
        mockAuth.mockResolvedValueOnce(owner());
        const to = await call(previewOpeningBalanceImportAction, form({ file: csvFile("ob.csv", csv) }));
        return to.split("/").pop()!.split("?")[0];
    }

    it("Posts DR AR / CR OBE per successful row, marks COMMITTED", async () => {
        await prisma.customer.create({ data: { garageId: gId, name: "Al Falah Motors", phone: "9990001" } });
        await prisma.customer.create({ data: { garageId: gId, name: "Sameer Ahmed", phone: "9990002" } });
        const csv = "Customer,Balance,As of\nAl Falah Motors,5000,2026-06-01\nSameer Ahmed,1200,2026-07-15";
        const batchId = await seedPreviewAndReturnBatchId(csv);
        mockAuth.mockResolvedValueOnce(owner());
        await call(commitLedgerImportBatchAction, form({ batchId }));

        const rows = await prisma.ledgerEntry.findMany({
            where: { garageId: gId, sourceType: "OPENING_BALANCE" },
            orderBy: { debit: "desc" },
        });
        expect(rows).toHaveLength(4); // 2 pairs

        const ar = rows.filter((r) => r.account === ACCOUNTS.AR);
        const obe = rows.filter((r) => r.account === ACCOUNTS.OPENING_BALANCE_EQUITY);
        expect(ar.reduce((s, r) => s + Number(r.debit), 0)).toBe(6200);
        expect(obe.reduce((s, r) => s + Number(r.credit), 0)).toBe(6200);

        const batch = await prisma.ledgerImportBatch.findUnique({ where: { id: batchId } });
        expect(batch?.status).toBe("COMMITTED");
        expect(batch?.committedAt).toBeTruthy();
    });

    it("Customer not found → per-row error, no ledger post for that row", async () => {
        await prisma.customer.create({ data: { garageId: gId, name: "Present Customer", phone: "9990001" } });
        const csv = "Customer,Balance,As of\nPresent Customer,1000,2026-06-01\nMissing Person,500,2026-06-01";
        const batchId = await seedPreviewAndReturnBatchId(csv);
        mockAuth.mockResolvedValueOnce(owner());
        await call(commitLedgerImportBatchAction, form({ batchId }));

        // Only 1 pair posted (for Present Customer). Missing Person failed.
        const pairs = await prisma.ledgerEntry.count({
            where: { garageId: gId, sourceType: "OPENING_BALANCE" },
        });
        expect(pairs).toBe(2);

        const errors = await prisma.ledgerImportError.findMany({ where: { batchId } });
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toMatch(/not found/i);
    });

    it("Ambiguous name → per-row error", async () => {
        await prisma.customer.create({ data: { garageId: gId, name: "Ali", phone: "9990001" } });
        await prisma.customer.create({ data: { garageId: gId, name: "ali", phone: "9990002" } }); // lowercase — same key
        const csv = "Customer,Balance,As of\nAli,500,2026-06-01";
        const batchId = await seedPreviewAndReturnBatchId(csv);
        mockAuth.mockResolvedValueOnce(owner());
        await call(commitLedgerImportBatchAction, form({ batchId }));
        const errors = await prisma.ledgerImportError.findMany({ where: { batchId } });
        expect(errors[0].reason).toMatch(/ambiguous/i);
        expect(await prisma.ledgerEntry.count({ where: { garageId: gId } })).toBe(0);
    });

    it("Customer already has OB → refused as duplicate", async () => {
        const c = await prisma.customer.create({ data: { garageId: gId, name: "Repeat Customer", phone: "9990001" } });
        // Pre-seed an OB row for this customer
        const sourceId = `pre:1:${c.id}`;
        await prisma.ledgerEntry.createMany({
            data: [
                { garageId: gId, account: ACCOUNTS.AR, debit: 1000, credit: 0, sourceType: "OPENING_BALANCE", sourceId },
                { garageId: gId, account: ACCOUNTS.OPENING_BALANCE_EQUITY, debit: 0, credit: 1000, sourceType: "OPENING_BALANCE", sourceId },
            ],
        });
        const csv = "Customer,Balance,As of\nRepeat Customer,500,2026-06-01";
        const batchId = await seedPreviewAndReturnBatchId(csv);
        mockAuth.mockResolvedValueOnce(owner());
        await call(commitLedgerImportBatchAction, form({ batchId }));
        const errors = await prisma.ledgerImportError.findMany({ where: { batchId } });
        expect(errors[0].reason).toMatch(/already/i);
        // Still just the original 2 rows; no new pair posted.
        expect(await prisma.ledgerEntry.count({ where: { garageId: gId } })).toBe(2);
    });

    it("One bad row does NOT roll back the good rows", async () => {
        await prisma.customer.create({ data: { garageId: gId, name: "Good One", phone: "9990001" } });
        await prisma.customer.create({ data: { garageId: gId, name: "Good Two", phone: "9990002" } });
        // "Missing" is not in the customer table.
        const csv = [
            "Customer,Balance,As of",
            "Good One,100,2026-06-01",
            "Missing,200,2026-06-01",
            "Good Two,300,2026-06-01",
        ].join("\n");
        const batchId = await seedPreviewAndReturnBatchId(csv);
        mockAuth.mockResolvedValueOnce(owner());
        await call(commitLedgerImportBatchAction, form({ batchId }));

        const pairs = await prisma.ledgerEntry.findMany({
            where: { garageId: gId, sourceType: "OPENING_BALANCE", account: ACCOUNTS.AR },
        });
        expect(pairs).toHaveLength(2); // Good One + Good Two, Missing rejected
        const errors = await prisma.ledgerImportError.findMany({ where: { batchId } });
        expect(errors).toHaveLength(1);
        expect(errors[0].rowIndex).toBe(2); // 1-based, header excluded
    });

    it("Refuses commit on already-COMMITTED batch", async () => {
        await prisma.customer.create({ data: { garageId: gId, name: "One", phone: "9990001" } });
        const csv = "Customer,Balance,As of\nOne,100,2026-06-01";
        const batchId = await seedPreviewAndReturnBatchId(csv);
        mockAuth.mockResolvedValueOnce(owner());
        await call(commitLedgerImportBatchAction, form({ batchId }));
        mockAuth.mockResolvedValueOnce(owner());
        const to = await call(commitLedgerImportBatchAction, form({ batchId }));
        expect(decodeURIComponent(to)).toMatch(/already committed/i);
        // Still just one pair.
        expect(
            await prisma.ledgerEntry.count({ where: { garageId: gId, sourceType: "OPENING_BALANCE" } }),
        ).toBe(2);
    });
});

describe("discardLedgerImportBatchAction", () => {
    it("Sets DISCARDED, no writes", async () => {
        await prisma.customer.create({ data: { garageId: gId, name: "One", phone: "9990001" } });
        mockAuth.mockResolvedValueOnce(owner());
        const to = await call(
            previewOpeningBalanceImportAction,
            form({ file: csvFile("ob.csv", "Customer,Balance,As of\nOne,100,2026-06-01") }),
        );
        const batchId = to.split("/").pop()!.split("?")[0];
        mockAuth.mockResolvedValueOnce(owner());
        await call(discardLedgerImportBatchAction, form({ batchId }));
        const batch = await prisma.ledgerImportBatch.findUnique({ where: { id: batchId } });
        expect(batch?.status).toBe("DISCARDED");
        expect(batch?.discardedAt).toBeTruthy();
        expect(await prisma.ledgerEntry.count({ where: { garageId: gId } })).toBe(0);
    });
});
