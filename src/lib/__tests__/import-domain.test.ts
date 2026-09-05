/**
 * E7b step 3 — customer / vendor / item importers. AR 2026-09-03.
 *
 * Pins:
 *   PARSERS
 *     1. Customer: parses phone-plus-optional email/address.
 *     2. Vendor: parses name-plus-optional phone/email/trn.
 *     3. Item: parses sku+name+prices; blank prices default to 0.
 *
 *   COMMITTERS (each is a variant of the same shape)
 *     4. Customer commit skips existing (phone-normalised dedupe).
 *     5. Vendor commit skips existing (name-normalised dedupe).
 *     6. Item commit skips existing (SKU dedupe).
 *     7. Re-uploading the same file after commit → all rows skip.
 *     8. Same-file duplicate (two rows same key) → first creates, second skips.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { parseCustomerCsv, parseVendorCsv, parseItemCsv } from "@/lib/import/parse-customer";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        throw new Error("REDIRECT:" + url);
    },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-user", () => ({ sessionUserExists: async () => true }));

const {
    previewCustomerImportAction,
    previewVendorImportAction,
    previewItemImportAction,
    commitLedgerImportBatchAction,
} = await import("@/app/actions/import");

const P = "import-dom-test-";
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
    await prisma.ledgerImportError.deleteMany({
        where: { batch: { garageId: { startsWith: P } } },
    });
    await prisma.ledgerImportBatch.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.part.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.supplier.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { garageId: { startsWith: P } } });
    await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}
beforeEach(async () => {
    await cleanup();
    await prisma.garage.create({ data: { id: gId, name: gId } });
    await prisma.user.create({
        data: { id: P + "u", garageId: gId, role: "OWNER" as never, name: "O", email: P + "u@t.local" },
    });
    mockAuth.mockReset();
});
afterAll(cleanup);

describe("parsers", () => {
    it("Customer: phone required, email + address optional", () => {
        const csv = 'Customer,Phone,Email,Address\nAcme,0501234567,a@b.com,"Sheikh Zayed"\nBare,971509999999,,';
        const { rows, errors } = parseCustomerCsv(csv);
        expect(errors).toEqual([]);
        expect(rows[0].email).toBe("a@b.com");
        expect(rows[0].address).toBe("Sheikh Zayed");
        expect(rows[1].email).toBeNull();
        expect(rows[1].address).toBeNull();
    });

    it("Vendor: everything but name optional", () => {
        const csv = "Vendor,Phone,Email\nGarage Supplies LLC,,\nAl Hasan Auto Parts,+971501234567,ali@ahap.ae";
        const { rows, errors } = parseVendorCsv(csv);
        expect(errors).toEqual([]);
        expect(rows[0].phone).toBeNull();
        expect(rows[1].phone).toBe("+971501234567");
    });

    it("Item: blank prices default to 0", () => {
        const csv = "Item Name,SKU,Sales Price,Purchase Cost\nBrake pad,BRK-1,250,120\nMystery,MYS-1,,";
        const { rows, errors } = parseItemCsv(csv);
        expect(errors).toEqual([]);
        expect(rows[0].price).toBe(250);
        expect(rows[1].price).toBe(0);
        expect(rows[1].cost).toBe(0);
    });
});

describe("commit customer batch — phone-normalised dedupe", () => {
    it("Skips existing customer with same normalised phone", async () => {
        // Prime with a customer whose phone normalises to same key as one CSV row
        await prisma.customer.create({ data: { garageId: gId, name: "Existing", phone: "971501234567" } });
        const csv =
            "Customer,Phone,Email\n" +
            "Al Falah Motors,+971 50 123 4567,a@b.com\n" + // same normalised phone → skip
            "New Customer,971509999999,c@d.com";
        mockAuth.mockResolvedValueOnce(owner());
        const to1 = await call(previewCustomerImportAction, form({ file: csvFile("c.csv", csv) }));
        const batchId = to1.split("/").pop()!.split("?")[0];
        mockAuth.mockResolvedValueOnce(owner());
        const to2 = await call(commitLedgerImportBatchAction, form({ batchId }));
        expect(decodeURIComponent(to2)).toContain("committed=1");
        expect(decodeURIComponent(to2)).toContain("skipped=1");
        const created = await prisma.customer.count({ where: { garageId: gId } });
        expect(created).toBe(2); // Existing + New Customer
    });

    it("Same-file duplicate: first creates, second skips", async () => {
        const csv =
            "Customer,Phone,Email\n" +
            "First Row,+971501234567,\n" +
            "Second Row Same Phone,971501234567,";
        mockAuth.mockResolvedValueOnce(owner());
        const to1 = await call(previewCustomerImportAction, form({ file: csvFile("c.csv", csv) }));
        const batchId = to1.split("/").pop()!.split("?")[0];
        mockAuth.mockResolvedValueOnce(owner());
        const to2 = await call(commitLedgerImportBatchAction, form({ batchId }));
        expect(decodeURIComponent(to2)).toContain("committed=1");
        expect(decodeURIComponent(to2)).toContain("skipped=1");
    });
});

describe("commit vendor batch — name dedupe", () => {
    it("Skips existing vendor with same (case-insensitive) name", async () => {
        await prisma.supplier.create({ data: { garageId: gId, name: "Al Hasan Auto Parts" } });
        const csv = "Vendor,Phone\nAL HASAN AUTO PARTS,+971501234567\nBrand New Vendor,971509999999";
        mockAuth.mockResolvedValueOnce(owner());
        const to1 = await call(previewVendorImportAction, form({ file: csvFile("v.csv", csv) }));
        const batchId = to1.split("/").pop()!.split("?")[0];
        mockAuth.mockResolvedValueOnce(owner());
        const to2 = await call(commitLedgerImportBatchAction, form({ batchId }));
        expect(decodeURIComponent(to2)).toContain("committed=1");
        expect(decodeURIComponent(to2)).toContain("skipped=1");
        expect(await prisma.supplier.count({ where: { garageId: gId } })).toBe(2);
    });
});

describe("commit item batch — SKU dedupe", () => {
    it("Skips existing part with same SKU", async () => {
        await prisma.part.create({
            data: { garageId: gId, sku: "BRK-1", name: "Brake pad", cost: 100, price: 250 },
        });
        const csv =
            "Item Name,SKU,Sales Price,Purchase Cost\n" +
            "Brake pad,BRK-1,300,150\n" +
            "New Part,NEW-1,50,30";
        mockAuth.mockResolvedValueOnce(owner());
        const to1 = await call(previewItemImportAction, form({ file: csvFile("i.csv", csv) }));
        const batchId = to1.split("/").pop()!.split("?")[0];
        mockAuth.mockResolvedValueOnce(owner());
        const to2 = await call(commitLedgerImportBatchAction, form({ batchId }));
        expect(decodeURIComponent(to2)).toContain("committed=1");
        expect(decodeURIComponent(to2)).toContain("skipped=1");
        const existing = await prisma.part.findFirst({
            where: { garageId: gId, sku: "BRK-1" },
            select: { price: true },
        });
        // Existing part's price NOT overwritten — dedupe is skip, not update.
        expect(Number(existing?.price)).toBe(250);
    });
});
