/**
 * Customer statement loader (AR 2026-08-25, Batch B).
 *
 * Pure DB-read + shape assembly for /advisor/customers/[id]/statement.
 * Route stays thin; aging math and totals live here so they're
 * testable without a database.
 *
 * Garage scope: enforced by the WHERE — Customer.garageId must equal
 * the caller-supplied garageId. Returns null when the customer
 * doesn't exist OR when it exists but sits in a different garage.
 * Route turns null into notFound() so cross-garage existence never
 * leaks via status code.
 *
 * Aging: calculated against the caller-supplied asOfDate (defaults
 * to now at the route layer). Days-past-due = max(0, floor(
 *   (asOfDate - invoice.dueDate) / 24h )). Voided invoices are
 * excluded entirely — they don't count toward AR (their reversal
 * ledger entries net them to zero).
 *
 * Unmigrated advances (AdvancePayment.migratedAt === null) count as
 * CREDITS against the balance: money the customer paid us that isn't
 * yet applied to an invoice. netBalance = Σ outstanding − Σ advances.
 *
 * Read-only. Zero writes.
 */

import { prisma } from "@/lib/prisma";

export type AgingBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus";

export interface StatementInvoiceRow {
    invoiceId: string;
    invoiceNumber: number;
    issuedAt: Date;
    dueDate: Date;
    vehiclePlate: string;
    vehicleMakeModel: string;
    total: number;
    paid: number;
    outstanding: number;
    /** Days past dueDate at asOfDate. 0 when not-yet-due or exactly-
     *  due. Undefined semantics for fully-paid rows — the page shows
     *  a dash instead of a bucket. */
    daysPastDue: number;
    bucket: AgingBucket;
    /** True when outstanding = 0. Row stays in the statement (an
     *  accountant reads the full period) but the page dims it. */
    fullyPaid: boolean;
    // ── Cost/margin — hidden by default on-screen (CostVisibilityToggle)
    // and always on print. Same rule as vehicle-history. Null when
    // no line-cost data is available.
    cost: number | null;
    margin: number | null;
}

export interface StatementAdvanceRow {
    advanceId: string;
    receivedAt: Date;
    method: string;
    amount: number;
    jobNumber: number | null;
    /** Human context: the vehicle the advance was captured against. */
    vehiclePlate: string;
}

export interface AgingSummary {
    current: number;
    d1_30: number;
    d31_60: number;
    d61_90: number;
    d90_plus: number;
    /** Sum of outstanding across ALL buckets (invoices only). */
    invoicesOutstanding: number;
    /** Sum of unmigrated advances — a credit. */
    advancesCredit: number;
    /** invoicesOutstanding − advancesCredit. What the customer
     *  actually owes right now. Can go negative when advances
     *  exceed unpaid invoices; that's a customer-in-credit position
     *  and the page shows it as such. */
    netBalance: number;
}

export interface CustomerStatement {
    customer: {
        id: string;
        name: string;
        phone: string;
        email: string | null;
        trn: string | null;
        phoneNeedsReview: boolean;
    };
    /** Every vehicle the customer CURRENTLY owns (Vehicle.customerId
     *  = customer.id). Historical ownership (transferred-out vehicles)
     *  isn't listed here — the statement is about the customer's
     *  current position, not their lifetime relationship. */
    currentVehicles: Array<{
        id: string;
        make: string;
        model: string;
        year: number | null;
        plate: string;
    }>;
    asOfDate: Date;
    invoices: StatementInvoiceRow[];
    advances: StatementAdvanceRow[];
    aging: AgingSummary;
    garage: {
        id: string;
        name: string;
        country: string | null;
        trn: string | null;
        logoUrl: string | null;
    };
}

// Bucket boundaries. Exact `31 days past due` sits in the `31_60`
// bucket, not `1_30` — the >= vs > choice matters and this comment
// pins it. AR-inspired convention matches how a UAE SME reads its
// AR aging (30/60/90 boundaries).
export function bucketFor(daysPastDue: number): AgingBucket {
    if (daysPastDue <= 0) return "current";
    if (daysPastDue <= 30) return "d1_30";
    if (daysPastDue <= 60) return "d31_60";
    if (daysPastDue <= 90) return "d61_90";
    return "d90_plus";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between two Dates, floored. Positive when `later` is
 *  after `earlier`. Truncated to day precision so a same-day pair
 *  reads as 0, an exactly-one-day gap reads as 1. */
function daysBetween(earlier: Date, later: Date): number {
    return Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

export async function loadCustomerStatement(
    customerId: string,
    garageId: string,
    asOfDate: Date,
): Promise<CustomerStatement | null> {
    const customer = await prisma.customer.findFirst({
        where: { id: customerId, garageId },
        select: {
            id: true, name: true, phone: true, email: true, trn: true,
            phoneNeedsReview: true,
            garage: {
                select: { id: true, name: true, country: true, trn: true, logoUrl: true },
            },
            vehicles: {
                select: { id: true, make: true, model: true, year: true, plate: true },
                orderBy: { createdAt: "asc" },
            },
        },
    });
    if (!customer) return null;

    // Every invoice on every job for every vehicle this customer
    // CURRENTLY owns. Historic vehicles (ones transferred out) drop
    // off because Vehicle.customerId has moved to the new owner —
    // and that new owner's statement is where those show up.
    const vehicleIds = customer.vehicles.map((v) => v.id);
    const invoicesRaw = vehicleIds.length === 0
        ? []
        : await prisma.invoice.findMany({
            where: {
                jobCard: {
                    garageId,
                    vehicleId: { in: vehicleIds },
                },
                status: { not: "VOID" },
                issuedAt: { lte: asOfDate },
            },
            select: {
                id: true, number: true, issuedAt: true, dueDate: true,
                total: true,
                payments: { select: { amount: true } },
                lines: {
                    select: { qty: true, unitCost: true },
                },
                jobCard: {
                    select: {
                        vehicle: { select: { plate: true, make: true, model: true } },
                    },
                },
            },
            orderBy: { issuedAt: "asc" },
        });

    const invoices: StatementInvoiceRow[] = invoicesRaw.map((inv) => {
        const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
        const total = Number(inv.total);
        const outstanding = Number((total - paid).toFixed(2));
        const daysPastDue = Math.max(0, daysBetween(inv.dueDate, asOfDate));
        const cost = inv.lines.length > 0
            ? Number(inv.lines.reduce((s, l) => s + Number(l.qty) * Number(l.unitCost ?? 0), 0).toFixed(2))
            : null;
        const margin = cost !== null ? Number((total - cost).toFixed(2)) : null;
        return {
            invoiceId: inv.id,
            invoiceNumber: inv.number,
            issuedAt: inv.issuedAt,
            dueDate: inv.dueDate,
            vehiclePlate: inv.jobCard.vehicle.plate,
            vehicleMakeModel: `${inv.jobCard.vehicle.make} ${inv.jobCard.vehicle.model}`.trim(),
            total,
            paid,
            outstanding,
            daysPastDue,
            bucket: bucketFor(daysPastDue),
            fullyPaid: outstanding === 0,
            cost,
            margin,
        };
    });

    // Unmigrated advances captured against this customer's current
    // vehicles. Filter by JobCard.vehicleId ∈ current vehicles so
    // an advance recorded against a vehicle the customer has since
    // transferred away doesn't inflate this statement. AdvancePayment
    // .migratedAt === null means the advance hasn't been applied to
    // an invoice yet.
    const advancesRaw = vehicleIds.length === 0
        ? []
        : await prisma.advancePayment.findMany({
            where: {
                garageId,
                migratedAt: null,
                receivedAt: { lte: asOfDate },
                jobCard: { vehicleId: { in: vehicleIds } },
            },
            select: {
                id: true, receivedAt: true, method: true, amount: true,
                jobCard: {
                    select: {
                        number: true,
                        vehicle: { select: { plate: true } },
                    },
                },
            },
            orderBy: { receivedAt: "asc" },
        });

    const advances: StatementAdvanceRow[] = advancesRaw.map((a) => ({
        advanceId: a.id,
        receivedAt: a.receivedAt,
        method: a.method,
        amount: Number(a.amount),
        jobNumber: a.jobCard.number,
        vehiclePlate: a.jobCard.vehicle.plate,
    }));

    // Aging rollup — sum outstanding per bucket. Fully-paid rows
    // (outstanding=0) contribute 0 to every bucket and don't skew
    // the current bucket up.
    const aging: AgingSummary = {
        current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0,
        invoicesOutstanding: 0,
        advancesCredit: 0,
        netBalance: 0,
    };
    for (const inv of invoices) {
        if (inv.outstanding === 0) continue;
        switch (inv.bucket) {
            case "current":   aging.current   += inv.outstanding; break;
            case "d1_30":     aging.d1_30     += inv.outstanding; break;
            case "d31_60":    aging.d31_60    += inv.outstanding; break;
            case "d61_90":    aging.d61_90    += inv.outstanding; break;
            case "d90_plus":  aging.d90_plus  += inv.outstanding; break;
        }
    }
    aging.invoicesOutstanding = Number(
        (aging.current + aging.d1_30 + aging.d31_60 + aging.d61_90 + aging.d90_plus).toFixed(2),
    );
    aging.advancesCredit = Number(advances.reduce((s, a) => s + a.amount, 0).toFixed(2));
    aging.netBalance = Number((aging.invoicesOutstanding - aging.advancesCredit).toFixed(2));
    // Round each bucket for display cleanliness.
    aging.current   = Number(aging.current.toFixed(2));
    aging.d1_30     = Number(aging.d1_30.toFixed(2));
    aging.d31_60    = Number(aging.d31_60.toFixed(2));
    aging.d61_90    = Number(aging.d61_90.toFixed(2));
    aging.d90_plus  = Number(aging.d90_plus.toFixed(2));

    return {
        customer: {
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
            trn: customer.trn,
            phoneNeedsReview: customer.phoneNeedsReview,
        },
        currentVehicles: customer.vehicles,
        asOfDate,
        invoices,
        advances,
        aging,
        garage: customer.garage,
    };
}
