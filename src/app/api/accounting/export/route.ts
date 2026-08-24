/**
 * Accounting export — download endpoint (AR 2026-08-23).
 *
 * GET /api/accounting/export?file=<name>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 *   file: chart-of-accounts | journal | invoices | payments | customers
 *   from, to: inclusive-inclusive range; DEFAULT = current month
 *     (first-of-month → today). Full history is not the default — an
 *     accountant works in periods, and the whole ledger should be an
 *     explicit ask, not the miss-a-param outcome.
 *
 * Owner-only. `requireRole("OWNER")` gates the endpoint; garage scope
 * is `companyGarageIds(session.user.garageId)` — matches the existing
 * ledger/analytics pattern (owner's own garage plus every branch the
 * company owns, never any other company's garage).
 *
 * Read-only from business data. Reads LedgerEntry / Invoice / Payment
 * / AdvancePayment / Customer / Vehicle / JobCard. Writes ONE row per
 * download to AccountingExportLog (audit trail) — that's the ONLY DB
 * write this endpoint performs, and it's the whole point of the log:
 * "a file containing the entire financial position of the business
 * shouldn't leave without a record." See prisma/schema.prisma model
 * AccountingExportLog for the audit-schema rationale.
 *
 * Serves one CSV per request; no ZIP dep. Filename embeds the date
 * range so a file is self-describing after the download tab closes.
 */

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { companyGarageIds } from "@/lib/branches";
import {
    chartOfAccountsCsv,
    journalCsv,
    invoicesCsv,
    paymentsCsv,
    customersCsv,
    filename,
    type JournalRow,
    type InvoiceRow,
    type PaymentRow,
    type CustomerRow,
} from "@/lib/accounting-export";

// Valid ?file= values — keep in sync with the UI page's five buttons.
const VALID_FILES = new Set(["chart-of-accounts", "journal", "invoices", "payments", "customers"]);

// ── Date parsing ─────────────────────────────────────────────────────
// Accept only YYYY-MM-DD. Anything else falls back to the default
// (current month) rather than 500'ing — an accountant with a
// mistyped URL gets a sensible file, not an error page.

// Dubai-calendar → UTC boundaries. `2026-08-01` typed into the URL
// means "midnight Aug 1 in Dubai" = "20:00 Jul 31 UTC". Without this
// the filter drifted by 4 hours: a Dubai invoice at 02:00 on Sep 1
// (= 22:00 Aug 31 UTC) was included in August, which puts revenue
// in the wrong period on an accountant's books. AR 2026-08-25
// verify #2 — Dubai is +4 offset with no DST, so a fixed literal
// offset is correct. If a future GCC branch ships, this becomes a
// per-branch export split (not a mixed-timezone CSV).
const ACCOUNTING_TZ_OFFSET_MS = 4 * 60 * 60 * 1000; // Dubai = UTC+4

function parseIsoDate(raw: string | null): Date | null {
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    // Dubai midnight expressed as UTC = 20:00 the previous day. The
    // constructor eats the ISO string with an offset and returns the
    // correct UTC Date. Verified: "2026-08-01T00:00:00+04:00" →
    // 2026-07-31T20:00:00Z.
    const d = new Date(`${raw}T00:00:00+04:00`);
    if (Number.isNaN(d.getTime())) return null;
    return d;
}

function defaultRange(): { from: Date; to: Date } {
    // "Today" as an accountant reads it — Dubai calendar date. Shift
    // now by Dubai offset then read the UTC parts to get the Dubai
    // Y/M/D, then convert back to the Dubai-midnight UTC boundaries
    // via the same +04:00 trick.
    const now = new Date();
    const dubaiNow = new Date(now.getTime() + ACCOUNTING_TZ_OFFSET_MS);
    const y = dubaiNow.getUTCFullYear();
    const m = dubaiNow.getUTCMonth();
    const d = dubaiNow.getUTCDate();
    const from = new Date(Date.UTC(y, m, 1) - ACCOUNTING_TZ_OFFSET_MS);
    const to = new Date(Date.UTC(y, m, d) - ACCOUNTING_TZ_OFFSET_MS);
    return { from, to };
}

// Exclusive upper bound on the SQL side — the URL `to` is inclusive,
// so we shift by +1 day when hitting the DB. Keeps timestamp handling
// clean (no "23:59:59.999" magic).
function toExclusive(d: Date): Date {
    return new Date(d.getTime() + 24 * 60 * 60 * 1000);
}

export async function GET(req: Request): Promise<Response> {
    let session;
    try {
        session = await requireRole("OWNER");
    } catch {
        return new NextResponse("forbidden", { status: 403 });
    }

    const url = new URL(req.url);
    const file = url.searchParams.get("file") ?? "";
    if (!VALID_FILES.has(file)) {
        return new NextResponse(
            `bad file. one of: ${Array.from(VALID_FILES).join(", ")}`,
            { status: 400 },
        );
    }

    const fromParam = parseIsoDate(url.searchParams.get("from"));
    const toParam = parseIsoDate(url.searchParams.get("to"));
    const range = (fromParam && toParam) ? { from: fromParam, to: toParam } : defaultRange();
    if (range.from > range.to) {
        return new NextResponse("bad range: from > to", { status: 400 });
    }
    const toExcl = toExclusive(range.to);

    const gids = await companyGarageIds(session.user.garageId);

    // ── Audit log write ─────────────────────────────────────────────
    // Fire-and-forget from the CSV build's perspective: we await it
    // BEFORE serving so a DB write failure surfaces to the operator
    // as a 500 (better than serving a file with no audit trail). See
    // prisma/schema.prisma model AccountingExportLog for the rationale
    // behind the flat-string (no FK) shape.
    await prisma.accountingExportLog.create({
        data: {
            userId: session.user.id,
            userRole: session.user.role,
            ownerGarageId: session.user.garageId,
            scopeGarageIds: gids.join(";"),
            rangeFromIso: range.from.toISOString(),
            rangeToIso: range.to.toISOString(),
            file,
        },
    });

    // ── Route by file ───────────────────────────────────────────────
    let csv: string;
    switch (file) {
        case "chart-of-accounts": {
            // COA is time-invariant — the range is captured in the
            // audit log + filename anyway for consistency, but the
            // content is the same regardless of range.
            csv = chartOfAccountsCsv();
            break;
        }
        case "journal": {
            csv = await buildJournalCsv(gids, range.from, toExcl);
            break;
        }
        case "invoices": {
            csv = await buildInvoicesCsv(gids, range.from, toExcl);
            break;
        }
        case "payments": {
            csv = await buildPaymentsCsv(gids, range.from, toExcl);
            break;
        }
        case "customers": {
            csv = await buildCustomersCsv(gids, range.from, toExcl);
            break;
        }
        default:
            // Unreachable — VALID_FILES gate above catches all others.
            return new NextResponse("bad file", { status: 400 });
    }

    return new NextResponse(csv, {
        status: 200,
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename(file, range.from, range.to)}"`,
            "Cache-Control": "no-store",
        },
    });
}

// ── Journal ──────────────────────────────────────────────────────────
// Every LedgerEntry in the range, joined-through to resolved invoice
// number / customer name via sourceType/sourceId. paymentMethod is
// carried for Cash/Bank rows so the CSV builder can split them.
async function buildJournalCsv(garageIds: string[], from: Date, toExcl: Date): Promise<string> {
    const entries = await prisma.ledgerEntry.findMany({
        where: {
            garageId: { in: garageIds },
            createdAt: { gte: from, lt: toExcl },
        },
        select: {
            createdAt: true,
            account: true,
            debit: true,
            credit: true,
            sourceType: true,
            sourceId: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    // Bulk-load the source-side rows once per sourceType, then join
    // in-memory — avoids N+1 findUnique against a large ledger.
    const invoiceIds = new Set<string>();
    const paymentIds = new Set<string>();
    const advanceIds = new Set<string>();
    for (const e of entries) {
        if (e.sourceType === "INVOICE" || e.sourceType === "INVOICE_VOID") invoiceIds.add(e.sourceId);
        else if (e.sourceType === "PAYMENT") paymentIds.add(e.sourceId);
        else if (e.sourceType === "ADVANCE" || e.sourceType === "ADVANCE_MIGRATION") advanceIds.add(e.sourceId);
    }

    // invoiceIssuedAt threads through to formatInvoiceNo(seq, year)
    // at CSV render — the invoice's year, not the ledger row's year,
    // determines the INV-YYYY-#### shape. AR 2026-08-25 verify #2.
    type InvoiceJoin = { number: number; issuedAt: Date; customerName: string };
    const invoiceMap = new Map<string, InvoiceJoin>();
    if (invoiceIds.size > 0) {
        const invRows = await prisma.invoice.findMany({
            where: { id: { in: Array.from(invoiceIds) } },
            select: {
                id: true, number: true, issuedAt: true,
                jobCard: { select: { vehicle: { select: { customer: { select: { name: true } } } } } },
            },
        });
        for (const r of invRows) {
            invoiceMap.set(r.id, {
                number: r.number,
                issuedAt: r.issuedAt,
                customerName: r.jobCard.vehicle.customer.name,
            });
        }
    }

    type PaymentJoin = { invoiceNumber: number; invoiceIssuedAt: Date; customerName: string; method: "CASH" | "CARD" };
    const paymentMap = new Map<string, PaymentJoin>();
    if (paymentIds.size > 0) {
        const payRows = await prisma.payment.findMany({
            where: { id: { in: Array.from(paymentIds) } },
            select: {
                id: true, method: true,
                invoice: {
                    select: {
                        number: true, issuedAt: true,
                        jobCard: { select: { vehicle: { select: { customer: { select: { name: true } } } } } },
                    },
                },
            },
        });
        for (const r of payRows) {
            paymentMap.set(r.id, {
                invoiceNumber: r.invoice.number,
                invoiceIssuedAt: r.invoice.issuedAt,
                customerName: r.invoice.jobCard.vehicle.customer.name,
                method: r.method as "CASH" | "CARD",
            });
        }
    }

    type AdvanceJoin = { customerName: string; method: "CASH" | "CARD" };
    const advanceMap = new Map<string, AdvanceJoin>();
    if (advanceIds.size > 0) {
        const advRows = await prisma.advancePayment.findMany({
            where: { id: { in: Array.from(advanceIds) } },
            select: {
                id: true, method: true,
                jobCard: { select: { vehicle: { select: { customer: { select: { name: true } } } } } },
            },
        });
        for (const r of advRows) {
            advanceMap.set(r.id, {
                customerName: r.jobCard.vehicle.customer.name,
                method: r.method as "CASH" | "CARD",
            });
        }
    }

    const rows: JournalRow[] = entries.map((e) => {
        let invoiceNumber: number | null | undefined;
        let invoiceIssuedAt: Date | null | undefined;
        let customerName: string | null | undefined;
        let paymentMethod: "CASH" | "CARD" | null | undefined;
        if (e.sourceType === "INVOICE" || e.sourceType === "INVOICE_VOID") {
            const j = invoiceMap.get(e.sourceId);
            if (j) { invoiceNumber = j.number; invoiceIssuedAt = j.issuedAt; customerName = j.customerName; }
        } else if (e.sourceType === "PAYMENT") {
            const j = paymentMap.get(e.sourceId);
            if (j) { invoiceNumber = j.invoiceNumber; invoiceIssuedAt = j.invoiceIssuedAt; customerName = j.customerName; paymentMethod = j.method; }
        } else if (e.sourceType === "ADVANCE" || e.sourceType === "ADVANCE_MIGRATION") {
            const j = advanceMap.get(e.sourceId);
            if (j) { customerName = j.customerName; paymentMethod = j.method; }
        }
        return {
            createdAt: e.createdAt,
            account: e.account,
            debit: e.debit as unknown as number,
            credit: e.credit as unknown as number,
            sourceType: e.sourceType,
            sourceId: e.sourceId,
            invoiceNumber,
            invoiceIssuedAt,
            customerName,
            paymentMethod,
        };
    });

    return journalCsv(rows);
}

// ── Invoices ─────────────────────────────────────────────────────────
async function buildInvoicesCsv(garageIds: string[], from: Date, toExcl: Date): Promise<string> {
    const invs = await prisma.invoice.findMany({
        where: {
            jobCard: { garageId: { in: garageIds } },
            issuedAt: { gte: from, lt: toExcl },
        },
        select: {
            number: true, issuedAt: true, dueDate: true,
            customerTrn: true,
            subtotal: true, vatAmount: true, total: true, status: true,
            payments: { select: { amount: true } },
            jobCard: { select: { vehicle: { select: { customer: { select: { name: true } } } } } },
        },
        orderBy: { number: "asc" },
    });

    const rows: InvoiceRow[] = invs.map((i) => {
        const paid = i.payments.reduce((s, p) => s + Number(p.amount), 0);
        return {
            number: i.number,
            issuedAt: i.issuedAt,
            dueDate: i.dueDate,
            customerName: i.jobCard.vehicle.customer.name,
            customerTrn: i.customerTrn,
            subtotal: i.subtotal as unknown as number,
            vatAmount: i.vatAmount as unknown as number,
            total: i.total as unknown as number,
            status: i.status,
            paid,
            balance: Number(i.total) - paid,
        };
    });

    return invoicesCsv(rows);
}

// ── Payments ─────────────────────────────────────────────────────────
async function buildPaymentsCsv(garageIds: string[], from: Date, toExcl: Date): Promise<string> {
    const payments = await prisma.payment.findMany({
        where: {
            invoice: { jobCard: { garageId: { in: garageIds } } },
            paidAt: { gte: from, lt: toExcl },
        },
        select: {
            paidAt: true, method: true, amount: true,
            invoice: {
                select: {
                    number: true, issuedAt: true,
                    jobCard: { select: { vehicle: { select: { customer: { select: { name: true } } } } } },
                },
            },
        },
        orderBy: { paidAt: "asc" },
    });

    const advances = await prisma.advancePayment.findMany({
        where: {
            garageId: { in: garageIds },
            receivedAt: { gte: from, lt: toExcl },
        },
        select: {
            receivedAt: true, method: true, amount: true, paymentId: true,
            jobCard: {
                select: {
                    number: true,
                    vehicle: { select: { customer: { select: { name: true } } } },
                },
            },
        },
        orderBy: { receivedAt: "asc" },
    });

    // Second lookup for the "migrated_to_invoice" column — AdvancePayment
    // has a plain paymentId FK but no Prisma relation defined for
    // `payment`, so bulk-fetch the matching Payment.invoice.number in
    // one round trip rather than adding a schema relation just for this
    // export (constraint: additive only, no changes to existing tables).
    const migratedPaymentIds = advances
        .map((a) => a.paymentId)
        .filter((id): id is string => !!id);
    // Migrated invoice number + issuedAt keyed by paymentId. Both
    // are needed to render INV-YYYY-#### shape on the migration
    // column via formatInvoiceNo(seq, year).
    const migratedInvoiceByPaymentId = new Map<string, { number: number; issuedAt: Date }>();
    if (migratedPaymentIds.length > 0) {
        const migrated = await prisma.payment.findMany({
            where: { id: { in: migratedPaymentIds } },
            select: { id: true, invoice: { select: { number: true, issuedAt: true } } },
        });
        for (const m of migrated) {
            migratedInvoiceByPaymentId.set(m.id, {
                number: m.invoice.number,
                issuedAt: m.invoice.issuedAt,
            });
        }
    }

    const rows: PaymentRow[] = [
        ...payments.map((p): PaymentRow => ({
            kind: "PAYMENT",
            date: p.paidAt,
            method: p.method as "CASH" | "CARD",
            amount: p.amount as unknown as number,
            invoiceNumber: p.invoice.number,
            invoiceIssuedAt: p.invoice.issuedAt,
            customerName: p.invoice.jobCard.vehicle.customer.name,
        })),
        ...advances.map((a): PaymentRow => {
            const migrated = a.paymentId ? migratedInvoiceByPaymentId.get(a.paymentId) : undefined;
            return {
                kind: "ADVANCE",
                date: a.receivedAt,
                method: a.method as "CASH" | "CARD",
                amount: a.amount as unknown as number,
                jobNumber: a.jobCard.number,
                customerName: a.jobCard.vehicle.customer.name,
                migratedToInvoiceNumber: migrated?.number ?? null,
                migratedToInvoiceIssuedAt: migrated?.issuedAt ?? null,
            };
        }),
    ].sort((x, y) => x.date.getTime() - y.date.getTime());

    return paymentsCsv(rows);
}

// ── Customers (range-scoped: only those with invoices in range) ─────
async function buildCustomersCsv(garageIds: string[], from: Date, toExcl: Date): Promise<string> {
    // Distinct customer ids that appear on invoices in the range.
    // Two-step: find invoices in range → distinct customer ids →
    // fetch. Keeps the customer scope tight to what an accountant
    // needs for the invoices you're also handing over.
    const invs = await prisma.invoice.findMany({
        where: {
            jobCard: { garageId: { in: garageIds } },
            issuedAt: { gte: from, lt: toExcl },
        },
        select: { jobCard: { select: { vehicle: { select: { customerId: true } } } } },
    });
    const customerIds = new Set<string>();
    for (const i of invs) customerIds.add(i.jobCard.vehicle.customerId);
    if (customerIds.size === 0) {
        return customersCsv([]);
    }

    const customers = await prisma.customer.findMany({
        where: { id: { in: Array.from(customerIds) } },
        select: {
            id: true, name: true, phone: true, email: true, trn: true,
        },
        orderBy: { name: "asc" },
    });

    // Count invoices per customer in the same range for the CSV column.
    const counts = new Map<string, number>();
    for (const i of invs) {
        const cid = i.jobCard.vehicle.customerId;
        counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }

    const rows: CustomerRow[] = customers.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        trn: c.trn,
        invoicesInRange: counts.get(c.id) ?? 0,
    }));

    return customersCsv(rows);
}
