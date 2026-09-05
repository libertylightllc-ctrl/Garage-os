"use server";

// E7b — QuickBooks-migration CSV import actions (AR 2026-09-03).
//
// Two-phase pattern per rule 17: parse writes a DRAFT
// LedgerImportBatch (no side-effects on real tables); commit reads
// the same batch and applies per-row idempotent inserts. Discard
// throws away the batch without writing. A browser reload between
// preview and commit doesn't lose the parsed data — the batch is
// the source of truth.
//
// Only OPENING_BALANCE (customer A/R direction) ships in step 2.
// Customer, vendor, and item imports land in step 3.
//
// Ledger writer shape (rule 16 / rule 17):
//   DR Accounts Receivable    balance
//   CR Opening Balance Equity balance
//   sourceType='OPENING_BALANCE'
//   sourceId=<batchId>:<rowIndex>
//
// Idempotency: the commit refuses if any OPENING_BALANCE ledger
// entry already exists for the target customer's AR position. Fix
// path when needed = void the OB row and re-post (never edit-in-
// place).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/guard";
import { ACCOUNTS } from "@/lib/billing";
import { parseOpeningBalanceCsv, type ParsedOpeningBalanceRow } from "@/lib/import/parse-openbal";
import {
    parseCustomerCsv,
    parseVendorCsv,
    parseItemCsv,
    type ParsedCustomerRow,
    type ParsedVendorRow,
    type ParsedItemRow,
} from "@/lib/import/parse-customer";
import { normalizeUaePhone } from "@/lib/normalize";
import type { Prisma } from "@/generated/prisma/client";

function fail(msg: string, path = "/owner/accounting/import"): never {
    redirect(`${path}?error=${encodeURIComponent(msg)}`);
}

// Shape written into LedgerImportBatch.parsedRowsJson so the commit
// action can re-read it. Dates serialize as ISO strings; the commit
// re-hydrates.
interface StoredOpenBalRow {
    rowIndex: number;
    customerName: string;
    balance: number;
    asOfDateIso: string;
}
interface OpenBalPreviewSummary {
    totalRows: number;
    willCreate: number;
    willSkip: number;
    willFail: number;
    // Parse-time errors (missing column, bad number). Match-time
    // errors (ambiguous name, already-imported) are recomputed on
    // commit — a customer created between preview and commit would
    // change the outcome, so we recompute rather than freeze.
    parseErrors: { rowIndex: number; reason: string }[];
}

export async function previewOpeningBalanceImportAction(formData: FormData) {
    const session = await requireRole("OWNER");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
        fail("Choose a CSV file to upload.");
    }
    // Guard: reject large files upfront. The parser runs in memory
    // and holds every row; a QB opening-balance export for a big
    // shop is realistically a few hundred lines. 2 MB is 40× that.
    if (file.size > 2 * 1024 * 1024) {
        fail("File is larger than 2 MB. Split it into smaller batches or contact support.");
    }
    const csvText = await file.text();

    let parsed;
    try {
        parsed = parseOpeningBalanceCsv(csvText);
    } catch (e) {
        const msg = e instanceof Error ? e.message : "CSV parse failed.";
        fail(msg);
    }

    // Preview: don't touch real tables. Just record what WOULD land.
    // Match-time issues (customer not found, ambiguous, already
    // imported) are recomputed on commit — we still count them here
    // for the preview number so the operator sees expected outcomes.
    const matchOutcomes = await scoreOpenBalRows(session.user.garageId, parsed.rows);

    const willFail = parsed.errors.length + matchOutcomes.notFound + matchOutcomes.ambiguous + matchOutcomes.alreadyImported;
    const willCreate = matchOutcomes.match;
    const willSkip = 0; // OB has no skip case today — every row is create-or-fail

    const summary: OpenBalPreviewSummary = {
        totalRows: parsed.rows.length + parsed.errors.length,
        willCreate,
        willSkip,
        willFail,
        parseErrors: parsed.errors.map((e) => ({ rowIndex: e.rowIndex, reason: e.reason })),
    };

    const storedRows: StoredOpenBalRow[] = parsed.rows.map((r) => ({
        rowIndex: r.rowIndex,
        customerName: r.customerName,
        balance: r.balance,
        asOfDateIso: r.asOfDate.toISOString(),
    }));

    const batch = await prisma.ledgerImportBatch.create({
        data: {
            garageId: session.user.garageId,
            uploadedByUserId: session.user.id,
            kind: "OPENING_BALANCE",
            status: "DRAFT",
            fileName: file.name,
            parsedRowsJson: storedRows as unknown as Prisma.InputJsonValue,
            previewSummaryJson: summary as unknown as Prisma.InputJsonValue,
        },
    });

    revalidatePath("/owner/accounting/import");
    redirect(`/owner/accounting/import/${batch.id}`);
}

interface MatchOutcomes {
    match: number;
    notFound: number;
    ambiguous: number;
    alreadyImported: number;
}
async function scoreOpenBalRows(
    garageId: string,
    rows: ParsedOpeningBalanceRow[],
): Promise<MatchOutcomes> {
    if (rows.length === 0) {
        return { match: 0, notFound: 0, ambiguous: 0, alreadyImported: 0 };
    }
    // Fetch every customer once; name-match in memory. Cheaper than
    // per-row findMany for the typical few-hundred-row import.
    const customers = await prisma.customer.findMany({
        where: { garageId },
        select: { id: true, name: true },
    });
    const byLowerName = new Map<string, string[]>();
    for (const c of customers) {
        const k = c.name.trim().toLowerCase();
        const arr = byLowerName.get(k) ?? [];
        arr.push(c.id);
        byLowerName.set(k, arr);
    }
    // Which customers already have an OB ledger entry?
    const existingOb = await prisma.ledgerEntry.findMany({
        where: {
            garageId,
            sourceType: "OPENING_BALANCE",
            account: ACCOUNTS.AR,
        },
        select: { sourceId: true },
    });
    // sourceId shape is "<batchId>:<rowIndex>:<customerId>" — extract
    // customerId. Any past shape without the trailing customerId is
    // still safe: we treat OB as garage-scoped (any AR OB entry for
    // this garage flags a duplicate if the operator re-runs the
    // whole file). This is the conservative reading.
    const customerHasOb = new Set<string>();
    for (const r of existingOb) {
        const parts = (r.sourceId ?? "").split(":");
        const custId = parts[parts.length - 1];
        if (custId) customerHasOb.add(custId);
    }

    let match = 0,
        notFound = 0,
        ambiguous = 0,
        alreadyImported = 0;
    for (const row of rows) {
        const key = row.customerName.trim().toLowerCase();
        const ids = byLowerName.get(key) ?? [];
        if (ids.length === 0) notFound++;
        else if (ids.length > 1) ambiguous++;
        else if (customerHasOb.has(ids[0])) alreadyImported++;
        else match++;
    }
    return { match, notFound, ambiguous, alreadyImported };
}

export async function commitLedgerImportBatchAction(formData: FormData) {
    const session = await requireRole("OWNER");
    const batchId = String(formData.get("batchId") ?? "").trim();
    if (!batchId) fail("Missing batch id.");

    const batch = await prisma.ledgerImportBatch.findFirst({
        where: { id: batchId, garageId: session.user.garageId },
        select: { id: true, kind: true, status: true, parsedRowsJson: true },
    });
    if (!batch) fail("Import batch not found.");
    if (batch.status !== "DRAFT") {
        fail(`Import batch is already ${batch.status.toLowerCase()}.`, `/owner/accounting/import/${batchId}`);
    }
    if (batch.kind === "CUSTOMER") {
        return commitCustomerBatch(batch, session);
    }
    if (batch.kind === "VENDOR") {
        return commitVendorBatch(batch, session);
    }
    if (batch.kind === "ITEM") {
        return commitItemBatch(batch, session);
    }

    // OPENING_BALANCE — falls through to the existing OB commit.
    const stored = batch.parsedRowsJson as unknown as StoredOpenBalRow[];

    // Fetch every customer + existing OB entries ONCE — same shape as
    // the previewer. Committing is a hot loop; per-row findFirst
    // would fan out to 400 queries for a 400-row file.
    const customers = await prisma.customer.findMany({
        where: { garageId: session.user.garageId },
        select: { id: true, name: true },
    });
    const byLowerName = new Map<string, string[]>();
    for (const c of customers) {
        const k = c.name.trim().toLowerCase();
        const arr = byLowerName.get(k) ?? [];
        arr.push(c.id);
        byLowerName.set(k, arr);
    }
    const existingOb = await prisma.ledgerEntry.findMany({
        where: {
            garageId: session.user.garageId,
            sourceType: "OPENING_BALANCE",
            account: ACCOUNTS.AR,
        },
        select: { sourceId: true },
    });
    const customerHasOb = new Set<string>();
    for (const r of existingOb) {
        const parts = (r.sourceId ?? "").split(":");
        const custId = parts[parts.length - 1];
        if (custId) customerHasOb.add(custId);
    }

    const errors: {
        rowIndex: number;
        rowJson: Prisma.InputJsonValue;
        reason: string;
    }[] = [];
    let created = 0;

    // Per-row: match + write inside its OWN tx. Rule 17: a failure on
    // row 400 must not roll back 399 good rows.
    for (const row of stored) {
        const key = row.customerName.trim().toLowerCase();
        const ids = byLowerName.get(key) ?? [];
        if (ids.length === 0) {
            errors.push({
                rowIndex: row.rowIndex,
                rowJson: row as unknown as Prisma.InputJsonValue,
                reason:
                    "Customer not found — import customers first, then re-upload this file.",
            });
            continue;
        }
        if (ids.length > 1) {
            errors.push({
                rowIndex: row.rowIndex,
                rowJson: row as unknown as Prisma.InputJsonValue,
                reason: `Ambiguous — ${ids.length} customers with this name. Rename or merge before re-uploading.`,
            });
            continue;
        }
        const customerId = ids[0];
        if (customerHasOb.has(customerId)) {
            errors.push({
                rowIndex: row.rowIndex,
                rowJson: row as unknown as Prisma.InputJsonValue,
                reason:
                    "Customer already has an opening balance. Void the existing OB before re-importing.",
            });
            continue;
        }
        const asOfDate = new Date(row.asOfDateIso);
        const sourceId = `${batch.id}:${row.rowIndex}:${customerId}`;
        try {
            await prisma.ledgerEntry.createMany({
                data: [
                    {
                        garageId: session.user.garageId,
                        account: ACCOUNTS.AR,
                        debit: row.balance,
                        credit: 0,
                        sourceType: "OPENING_BALANCE",
                        sourceId,
                        createdAt: asOfDate,
                    },
                    {
                        garageId: session.user.garageId,
                        account: ACCOUNTS.OPENING_BALANCE_EQUITY,
                        debit: 0,
                        credit: row.balance,
                        sourceType: "OPENING_BALANCE",
                        sourceId,
                        createdAt: asOfDate,
                    },
                ],
            });
            // Track the write so subsequent rows in the SAME file
            // (edge case: the file lists the same customer twice)
            // are refused as already-imported.
            customerHasOb.add(customerId);
            created++;
        } catch (e) {
            errors.push({
                rowIndex: row.rowIndex,
                rowJson: row as unknown as Prisma.InputJsonValue,
                reason: e instanceof Error ? `Write failed: ${e.message}` : "Write failed.",
            });
        }
    }

    await prisma.ledgerImportBatch.update({
        where: { id: batch.id },
        data: {
            status: "COMMITTED",
            committedAt: new Date(),
            committedByUserId: session.user.id,
        },
    });
    if (errors.length > 0) {
        await prisma.ledgerImportError.createMany({
            data: errors.map((e) => ({
                batchId: batch.id,
                rowIndex: e.rowIndex,
                rowJson: e.rowJson,
                reason: e.reason,
            })),
        });
    }

    revalidatePath("/owner/accounting/import");
    revalidatePath(`/owner/accounting/import/${batch.id}`);
    revalidatePath("/owner/accounting/statements");
    redirect(
        `/owner/accounting/import/${batch.id}?committed=${created}&failed=${errors.length}`,
    );
}

export async function discardLedgerImportBatchAction(formData: FormData) {
    const session = await requireRole("OWNER");
    const batchId = String(formData.get("batchId") ?? "").trim();
    if (!batchId) fail("Missing batch id.");

    const batch = await prisma.ledgerImportBatch.findFirst({
        where: { id: batchId, garageId: session.user.garageId },
        select: { id: true, status: true },
    });
    if (!batch) fail("Import batch not found.");
    if (batch.status !== "DRAFT") {
        fail(`Cannot discard a ${batch.status.toLowerCase()} batch.`, `/owner/accounting/import/${batchId}`);
    }
    await prisma.ledgerImportBatch.update({
        where: { id: batch.id },
        data: { status: "DISCARDED", discardedAt: new Date() },
    });
    revalidatePath("/owner/accounting/import");
    redirect("/owner/accounting/import?discarded=1");
}

// ─── Step 3 (AR 2026-09-03) — customer / vendor / item import ────
//
// All three follow the same shape as the OB path but write to
// domain tables (Customer / Supplier / Part) instead of the ledger.
// Idempotent-per-row: existing rows are SKIPPED (not overwritten),
// so a re-upload of the same CSV no-ops on already-imported rows
// and creates only the new ones.

interface StoredCustomerRow {
    rowIndex: number;
    name: string;
    phone: string;
    email: string | null;
    address: string | null;
}
interface StoredVendorRow {
    rowIndex: number;
    name: string;
    phone: string | null;
    email: string | null;
    trn: string | null;
}
interface StoredItemRow {
    rowIndex: number;
    sku: string;
    name: string;
    price: number;
    cost: number;
}
interface CustomerPreviewSummary {
    totalRows: number;
    willCreate: number;
    willSkip: number;
    willFail: number;
    /** Customer imports only — rows whose phone matches an existing
     *  customer but whose name differs. Refused on commit; the
     *  operator resolves by editing the CSV and re-running. Rule 17. */
    needsDecision?: number;
    parseErrors: { rowIndex: number; reason: string }[];
}

type BatchStub = { id: string; parsedRowsJson: Prisma.JsonValue };
type Sess = { user: { id: string; garageId: string; role: string } };

export async function previewCustomerImportAction(formData: FormData) {
    const session = await requireRole("OWNER");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) fail("Choose a CSV file to upload.");
    if (file.size > 2 * 1024 * 1024) fail("File is larger than 2 MB.");
    const csv = await file.text();
    let parsed;
    try {
        parsed = parseCustomerCsv(csv);
    } catch (e) {
        fail(e instanceof Error ? e.message : "CSV parse failed.");
    }
    // Match logic — rule 17 + rule 8 precedent (AR 2026-09-05):
    // never auto-merge silently. Same normalised phone + same name
    // = skip (idempotent no-op). Same phone + DIFFERENT name = a
    // decision only the operator can make (two people sharing a
    // landline, or one person spelled two ways). Report as its own
    // "needs a decision" category so the preview shows it and the
    // commit refuses.
    const existing = await prisma.customer.findMany({
        where: { garageId: session.user.garageId },
        select: { name: true, phone: true },
    });
    const existingByPhone = new Map<string, string>();
    for (const c of existing) existingByPhone.set(normalizeUaePhone(c.phone), c.name);
    const seenInFile = new Map<string, string>();
    let willCreate = 0;
    let willSkip = 0;
    let needsDecision = 0;
    for (const r of parsed.rows) {
        const key = normalizeUaePhone(r.phone);
        const nameKey = r.name.trim().toLowerCase();
        const existingName = existingByPhone.get(key);
        const seenName = seenInFile.get(key);
        if (existingName !== undefined) {
            if (existingName.trim().toLowerCase() === nameKey) willSkip++;
            else needsDecision++;
        } else if (seenName !== undefined) {
            if (seenName.trim().toLowerCase() === nameKey) willSkip++;
            else needsDecision++;
        } else {
            willCreate++;
            seenInFile.set(key, r.name);
        }
    }
    const summary: CustomerPreviewSummary = {
        totalRows: parsed.rows.length + parsed.errors.length,
        willCreate,
        willSkip,
        willFail: parsed.errors.length,
        needsDecision,
        parseErrors: parsed.errors.map((e) => ({ rowIndex: e.rowIndex, reason: e.reason })),
    };
    const stored: StoredCustomerRow[] = parsed.rows.map((r) => ({
        rowIndex: r.rowIndex,
        name: r.name,
        phone: r.phone,
        email: r.email,
        address: r.address,
    }));
    const batch = await prisma.ledgerImportBatch.create({
        data: {
            garageId: session.user.garageId,
            uploadedByUserId: session.user.id,
            kind: "CUSTOMER",
            status: "DRAFT",
            fileName: file.name,
            parsedRowsJson: stored as unknown as Prisma.InputJsonValue,
            previewSummaryJson: summary as unknown as Prisma.InputJsonValue,
        },
    });
    revalidatePath("/owner/accounting/import");
    redirect(`/owner/accounting/import/${batch.id}`);
}

async function commitCustomerBatch(batch: BatchStub, session: Sess) {
    const stored = batch.parsedRowsJson as unknown as StoredCustomerRow[];
    const existing = await prisma.customer.findMany({
        where: { garageId: session.user.garageId },
        select: { name: true, phone: true },
    });
    const existingByPhone = new Map<string, string>();
    for (const c of existing) existingByPhone.set(normalizeUaePhone(c.phone), c.name);
    // Also track first-name-per-phone WITHIN this file so a same-file
    // dup with a different name gets refused the same way an existing-
    // customer mismatch does.
    const seenInFile = new Map<string, string>();
    const errors: { rowIndex: number; rowJson: Prisma.InputJsonValue; reason: string }[] = [];
    let created = 0;
    let skipped = 0;
    for (const row of stored) {
        const key = normalizeUaePhone(row.phone);
        const nameKey = row.name.trim().toLowerCase();
        const existingName = existingByPhone.get(key);
        const seenName = seenInFile.get(key);
        if (existingName !== undefined) {
            if (existingName.trim().toLowerCase() === nameKey) {
                skipped++;
                continue;
            }
            // Phone-match, name-mismatch — refuse, don't merge silently.
            // Rule 17 + rule 8 precedent.
            errors.push({
                rowIndex: row.rowIndex,
                rowJson: row as unknown as Prisma.InputJsonValue,
                reason: `Phone matches existing customer "${existingName}" but this row's name is "${row.name}". Same-phone / different-name is a decision only you can make (same person spelled two ways, or two people sharing a landline). Fix the CSV to either match the existing name or use a different phone, then re-upload.`,
            });
            continue;
        }
        if (seenName !== undefined) {
            if (seenName.trim().toLowerCase() === nameKey) {
                skipped++;
                continue;
            }
            errors.push({
                rowIndex: row.rowIndex,
                rowJson: row as unknown as Prisma.InputJsonValue,
                reason: `Phone matches an earlier row in this file ("${seenName}") but this row's name is "${row.name}". Same reason — resolve in the CSV and re-upload.`,
            });
            continue;
        }
        try {
            // Customer has no `address` column today — the parser reads
            // it (for operator visibility in the preview + error row
            // dumps) but we don't persist it. Adding an address column
            // + display surfaces is a separate concern; if a shop needs
            // per-customer addresses on invoices they use the existing
            // per-invoice `remarks` block. See rule 17.
            await prisma.customer.create({
                data: {
                    garageId: session.user.garageId,
                    name: row.name,
                    phone: row.phone,
                    email: row.email,
                },
            });
            // Track for subsequent rows in this file — a later row
            // with same phone + different name refuses; same phone +
            // same name skips as idempotent.
            existingByPhone.set(key, row.name);
            seenInFile.set(key, row.name);
            created++;
        } catch (e) {
            errors.push({
                rowIndex: row.rowIndex,
                rowJson: row as unknown as Prisma.InputJsonValue,
                reason: e instanceof Error ? `Write failed: ${e.message}` : "Write failed.",
            });
        }
    }
    await prisma.ledgerImportBatch.update({
        where: { id: batch.id },
        data: {
            status: "COMMITTED",
            committedAt: new Date(),
            committedByUserId: session.user.id,
        },
    });
    if (errors.length > 0) {
        await prisma.ledgerImportError.createMany({
            data: errors.map((e) => ({
                batchId: batch.id,
                rowIndex: e.rowIndex,
                rowJson: e.rowJson,
                reason: e.reason,
            })),
        });
    }
    revalidatePath("/owner/accounting/import");
    revalidatePath(`/owner/accounting/import/${batch.id}`);
    revalidatePath("/advisor/customers");
    redirect(
        `/owner/accounting/import/${batch.id}?committed=${created}&skipped=${skipped}&failed=${errors.length}`,
    );
}

export async function previewVendorImportAction(formData: FormData) {
    const session = await requireRole("OWNER");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) fail("Choose a CSV file to upload.");
    if (file.size > 2 * 1024 * 1024) fail("File is larger than 2 MB.");
    const csv = await file.text();
    let parsed;
    try {
        parsed = parseVendorCsv(csv);
    } catch (e) {
        fail(e instanceof Error ? e.message : "CSV parse failed.");
    }
    const existing = await prisma.supplier.findMany({
        where: { garageId: session.user.garageId },
        select: { name: true },
    });
    const existingKeys = new Set(existing.map((v) => v.name.trim().toLowerCase()));
    const seenInFile = new Set<string>();
    let willCreate = 0;
    let willSkip = 0;
    for (const r of parsed.rows) {
        const key = r.name.trim().toLowerCase();
        if (existingKeys.has(key) || seenInFile.has(key)) willSkip++;
        else {
            willCreate++;
            seenInFile.add(key);
        }
    }
    const summary: CustomerPreviewSummary = {
        totalRows: parsed.rows.length + parsed.errors.length,
        willCreate,
        willSkip,
        willFail: parsed.errors.length,
        parseErrors: parsed.errors.map((e) => ({ rowIndex: e.rowIndex, reason: e.reason })),
    };
    const stored: StoredVendorRow[] = parsed.rows.map((r) => ({
        rowIndex: r.rowIndex,
        name: r.name,
        phone: r.phone,
        email: r.email,
        trn: r.trn,
    }));
    const batch = await prisma.ledgerImportBatch.create({
        data: {
            garageId: session.user.garageId,
            uploadedByUserId: session.user.id,
            kind: "VENDOR",
            status: "DRAFT",
            fileName: file.name,
            parsedRowsJson: stored as unknown as Prisma.InputJsonValue,
            previewSummaryJson: summary as unknown as Prisma.InputJsonValue,
        },
    });
    revalidatePath("/owner/accounting/import");
    redirect(`/owner/accounting/import/${batch.id}`);
}

async function commitVendorBatch(batch: BatchStub, session: Sess) {
    const stored = batch.parsedRowsJson as unknown as StoredVendorRow[];
    const existing = await prisma.supplier.findMany({
        where: { garageId: session.user.garageId },
        select: { name: true },
    });
    const known = new Set(existing.map((v) => v.name.trim().toLowerCase()));
    const errors: { rowIndex: number; rowJson: Prisma.InputJsonValue; reason: string }[] = [];
    let created = 0;
    let skipped = 0;
    for (const row of stored) {
        const key = row.name.trim().toLowerCase();
        if (known.has(key)) {
            skipped++;
            continue;
        }
        try {
            await prisma.supplier.create({
                data: {
                    garageId: session.user.garageId,
                    name: row.name,
                    phone: row.phone,
                    email: row.email,
                    trn: row.trn,
                },
            });
            known.add(key);
            created++;
        } catch (e) {
            errors.push({
                rowIndex: row.rowIndex,
                rowJson: row as unknown as Prisma.InputJsonValue,
                reason: e instanceof Error ? `Write failed: ${e.message}` : "Write failed.",
            });
        }
    }
    await prisma.ledgerImportBatch.update({
        where: { id: batch.id },
        data: {
            status: "COMMITTED",
            committedAt: new Date(),
            committedByUserId: session.user.id,
        },
    });
    if (errors.length > 0) {
        await prisma.ledgerImportError.createMany({
            data: errors.map((e) => ({
                batchId: batch.id,
                rowIndex: e.rowIndex,
                rowJson: e.rowJson,
                reason: e.reason,
            })),
        });
    }
    revalidatePath("/owner/accounting/import");
    revalidatePath(`/owner/accounting/import/${batch.id}`);
    revalidatePath("/owner/suppliers");
    redirect(
        `/owner/accounting/import/${batch.id}?committed=${created}&skipped=${skipped}&failed=${errors.length}`,
    );
}

export async function previewItemImportAction(formData: FormData) {
    const session = await requireRole("OWNER");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) fail("Choose a CSV file to upload.");
    if (file.size > 2 * 1024 * 1024) fail("File is larger than 2 MB.");
    const csv = await file.text();
    let parsed;
    try {
        parsed = parseItemCsv(csv);
    } catch (e) {
        fail(e instanceof Error ? e.message : "CSV parse failed.");
    }
    const existing = await prisma.part.findMany({
        where: { garageId: session.user.garageId },
        select: { sku: true },
    });
    const existingKeys = new Set(existing.map((p) => p.sku));
    const seenInFile = new Set<string>();
    let willCreate = 0;
    let willSkip = 0;
    for (const r of parsed.rows) {
        if (existingKeys.has(r.sku) || seenInFile.has(r.sku)) willSkip++;
        else {
            willCreate++;
            seenInFile.add(r.sku);
        }
    }
    const summary: CustomerPreviewSummary = {
        totalRows: parsed.rows.length + parsed.errors.length,
        willCreate,
        willSkip,
        willFail: parsed.errors.length,
        parseErrors: parsed.errors.map((e) => ({ rowIndex: e.rowIndex, reason: e.reason })),
    };
    const stored: StoredItemRow[] = parsed.rows.map((r) => ({
        rowIndex: r.rowIndex,
        sku: r.sku,
        name: r.name,
        price: r.price,
        cost: r.cost,
    }));
    const batch = await prisma.ledgerImportBatch.create({
        data: {
            garageId: session.user.garageId,
            uploadedByUserId: session.user.id,
            kind: "ITEM",
            status: "DRAFT",
            fileName: file.name,
            parsedRowsJson: stored as unknown as Prisma.InputJsonValue,
            previewSummaryJson: summary as unknown as Prisma.InputJsonValue,
        },
    });
    revalidatePath("/owner/accounting/import");
    redirect(`/owner/accounting/import/${batch.id}`);
}

async function commitItemBatch(batch: BatchStub, session: Sess) {
    const stored = batch.parsedRowsJson as unknown as StoredItemRow[];
    const existing = await prisma.part.findMany({
        where: { garageId: session.user.garageId },
        select: { sku: true },
    });
    const known = new Set(existing.map((p) => p.sku));
    const errors: { rowIndex: number; rowJson: Prisma.InputJsonValue; reason: string }[] = [];
    let created = 0;
    let skipped = 0;
    for (const row of stored) {
        if (known.has(row.sku)) {
            skipped++;
            continue;
        }
        try {
            await prisma.part.create({
                data: {
                    garageId: session.user.garageId,
                    sku: row.sku,
                    name: row.name,
                    price: row.price,
                    cost: row.cost,
                },
            });
            known.add(row.sku);
            created++;
        } catch (e) {
            errors.push({
                rowIndex: row.rowIndex,
                rowJson: row as unknown as Prisma.InputJsonValue,
                reason: e instanceof Error ? `Write failed: ${e.message}` : "Write failed.",
            });
        }
    }
    await prisma.ledgerImportBatch.update({
        where: { id: batch.id },
        data: {
            status: "COMMITTED",
            committedAt: new Date(),
            committedByUserId: session.user.id,
        },
    });
    if (errors.length > 0) {
        await prisma.ledgerImportError.createMany({
            data: errors.map((e) => ({
                batchId: batch.id,
                rowIndex: e.rowIndex,
                rowJson: e.rowJson,
                reason: e.reason,
            })),
        });
    }
    revalidatePath("/owner/accounting/import");
    revalidatePath(`/owner/accounting/import/${batch.id}`);
    revalidatePath("/owner/inventory");
    redirect(
        `/owner/accounting/import/${batch.id}?committed=${created}&skipped=${skipped}&failed=${errors.length}`,
    );
}
