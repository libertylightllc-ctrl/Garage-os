/**
 * Vehicle-history data loader (AR 2026-08-25, Batch A).
 *
 * Pure DB-read + shape assembly for the /advisor/vehicles/[id]/history
 * printable lookup. Route stays thin; shape rules live here so the
 * cost/margin derivation is testable without a database.
 *
 * Garage scope: enforced by the WHERE — Vehicle.customer.garageId
 * must equal the caller-supplied garageId. Returns null when the
 * vehicle doesn't exist OR when it exists but its customer is in a
 * different garage. Route turns null into notFound() so cross-garage
 * existence never leaks via status code.
 *
 * Read-only. Zero writes.
 */

import { prisma } from "@/lib/prisma";

/** Serialised money value — the loader converts Decimals to Number
 *  at the boundary so the route + tests can round-trip through JSON. */
export interface HistoryEntry {
    jobCardId: string;
    jobNumber: number | null;
    // Date the job was created (arrived at reception). Sortable +
    // human-readable at the page layer.
    date: Date;
    mileageIn: number | null;
    /** Advisor's short summary — customer complaint from intake. */
    complaint: string | null;
    /** Names of PART-kind lines from the invoice if invoiced; else
     *  from the approved estimate; else empty. */
    partsFitted: string[];
    /** LABOR/FEE line descriptions from the same source. */
    workDoneLines: string[];
    /** Final billable status of this visit. */
    status: string;
    /** Which owner owned the vehicle when this JC was opened. Null =
     *  no transfer has ever happened; the vehicle's current owner
     *  owned it since day one. Non-null = the transfer BEFORE this
     *  JC's createdAt named this customer as the new owner. */
    ownerAtJobTime: { id: string; name: string; phone: string } | null;
    // ── Money view — hidden by default on the page, always hidden
    // on print (see [data-print-omit-cost]). AR 2026-08-25.
    /** Total the customer sees on this visit's invoice, or the
     *  approved-estimate total if not yet invoiced. Null when neither
     *  exists. */
    revenue: number | null;
    /** Sum of (line qty * unitCost) across every line on the source
     *  of `revenue`. Null when we have no cost inputs (a labour-only
     *  visit with no cost columns, or a visit still in intake). */
    cost: number | null;
    /** revenue - cost. Null when either is null. */
    margin: number | null;
    /** Where `revenue` came from — makes the page label the row
     *  correctly ("invoiced" vs "estimated, not invoiced"). */
    source: "invoice" | "estimate" | "none";
    /** For invoiced visits: what's still outstanding on the invoice.
     *  Zero when fully paid; = revenue when unpaid. Null for non-
     *  invoiced sources. */
    outstanding: number | null;
    /** Invoice number for the link column, when invoiced. */
    invoiceNumber: number | null;
    invoiceId: string | null;
}

export interface OwnershipTransfer {
    at: Date;
    fromCustomerName: string;
    fromCustomerPhone: string;
    toCustomerName: string;
    toCustomerPhone: string;
}

export interface VehicleHistory {
    vehicle: {
        id: string;
        make: string;
        model: string;
        year: number | null;
        plate: string;
        vin: string | null;
        engineSize: string | null;
        fuelType: string | null;
    };
    currentOwner: { id: string; name: string; phone: string };
    /** True when the vehicle has been transferred at least once. The
     *  page uses this to render the "changed hands" flag next to the
     *  current-owner block. */
    hasChangedHands: boolean;
    transfers: OwnershipTransfer[];
    entries: HistoryEntry[];
    totals: {
        visits: number;
        lifetimeRevenue: number;
        lifetimeCost: number;
        lifetimeMargin: number;
        outstandingBalance: number;
    };
    garage: {
        id: string;
        name: string;
        country: string | null;
        trn: string | null;
        logoUrl: string | null;
    };
}

export async function loadVehicleHistory(
    vehicleId: string,
    garageId: string,
): Promise<VehicleHistory | null> {
    // Root query enforces garage scope by joining through
    // Vehicle.customer.garageId. A vehicle whose current owner is
    // in another garage returns null here.
    const vehicle = await prisma.vehicle.findFirst({
        where: { id: vehicleId, customer: { garageId } },
        select: {
            id: true,
            make: true,
            model: true,
            year: true,
            plate: true,
            vin: true,
            engineSize: true,
            fuelType: true,
            customer: {
                select: {
                    id: true, name: true, phone: true,
                    garage: {
                        select: { id: true, name: true, country: true, trn: true, logoUrl: true },
                    },
                },
            },
            ownershipTransfers: {
                select: {
                    transferredAt: true,
                    previousOwnerName: true,
                    previousOwnerPhone: true,
                    toCustomer: { select: { name: true, phone: true } },
                },
                orderBy: { transferredAt: "asc" },
            },
        },
    });
    if (!vehicle) return null;

    // Every JobCard on this vehicle. Include the estimate lines +
    // invoice lines needed to derive cost/margin, plus payments to
    // compute outstanding. Chronological ASC in the query for the
    // owner-at-job-time walk below; the page reverses to newest-
    // first for display.
    const jobs = await prisma.jobCard.findMany({
        where: { vehicleId, garageId },
        select: {
            id: true,
            number: true,
            createdAt: true,
            mileageIn: true,
            complaint: true,
            status: true,
            // Latest estimate by createdAt. A rejected/superseded
            // estimate on the same job is not the source of truth;
            // we take the last one written, matching how the ledger
            // treats it (Invoice snapshots the approved estimate at
            // invoice time).
            estimates: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                    status: true,
                    total: true,
                    lines: {
                        where: { declined: false },
                        select: {
                            kind: true, description: true,
                            qty: true, unitCost: true, lineTotal: true,
                        },
                    },
                },
            },
            // JobCard.invoices is plural — void+reissue means a job can
            // have multiple invoice rows over its life. Take the most
            // recent non-VOID one (falls back to the most recent if all
            // are voided, so an all-voided job still surfaces the last
            // amount as historical context).
            invoices: {
                select: {
                    id: true, number: true, total: true, status: true,
                    createdAt: true,
                    payments: { select: { amount: true } },
                    lines: {
                        select: {
                            kind: true, description: true,
                            qty: true, unitCost: true, lineTotal: true,
                        },
                    },
                },
                orderBy: { createdAt: "desc" },
            },
        },
        orderBy: { createdAt: "asc" },
    });

    // Build the ownership timeline — for each transfer, which JCs
    // fall on the FROM side vs the TO side. Walk transfers in the
    // order they happened; each JC gets tagged with the owner
    // active at its createdAt.
    //
    // The transfers array on Vehicle.ownershipTransfers names the
    // NEW owner (toCustomer) and snapshots the previous owner's
    // name+phone. To determine "owner at JC time" we don't need a
    // Customer FK to the previous owner — the snapshot is enough,
    // and it's the audit-safe read (the previous owner's Customer
    // row may have been edited since).
    const currentOwner = {
        id: vehicle.customer.id,
        name: vehicle.customer.name,
        phone: vehicle.customer.phone,
    };
    const transfers: OwnershipTransfer[] = vehicle.ownershipTransfers.map((t) => ({
        at: t.transferredAt,
        fromCustomerName: t.previousOwnerName,
        fromCustomerPhone: t.previousOwnerPhone,
        toCustomerName: t.toCustomer.name,
        toCustomerPhone: t.toCustomer.phone,
    }));

    // For each JC (chronological), determine ownerAtJobTime by
    // finding the latest transfer at or before the JC's createdAt.
    // Before any transfer → NULL (means: vehicle's current owner
    // owned it since day one).
    function ownerAtJobTime(jobCreatedAt: Date): HistoryEntry["ownerAtJobTime"] {
        if (transfers.length === 0) return null;
        // Find the most recent transfer AT OR BEFORE the JC. If none,
        // the JC predates every transfer — owner then was the initial
        // owner (the FROM side of the FIRST transfer).
        let priorTransfer: OwnershipTransfer | null = null;
        for (const t of transfers) {
            if (t.at.getTime() <= jobCreatedAt.getTime()) priorTransfer = t;
        }
        if (priorTransfer === null) {
            // JC is older than the earliest transfer → owner was the
            // FROM side of that first transfer (the initial owner).
            const first = transfers[0];
            return {
                id: "", // not linkable — the previous owner is a snapshot, no id
                name: first.fromCustomerName,
                phone: first.fromCustomerPhone,
            };
        }
        // JC happened AT OR AFTER a transfer → owner was the TO side
        // of that transfer.
        return {
            id: "",
            name: priorTransfer.toCustomerName,
            phone: priorTransfer.toCustomerPhone,
        };
    }

    const entries: HistoryEntry[] = jobs.map((j) => {
        // Prefer the most recent non-VOID invoice; if every invoice on
        // the job is voided, fall through to the most recent voided one
        // so the row still shows the last billed amount (with a status
        // that tells the story).
        const invoice = j.invoices.find((i) => i.status !== "VOID") ?? j.invoices[0] ?? null;
        const estimate = j.estimates[0] ?? null;

        // Cost/revenue source per row:
        //   invoice present            → source=invoice, revenue=invoice.total
        //   no invoice, estimate APPROVED → source=estimate, revenue=estimate.total
        //   otherwise (DRAFT/SENT/REJECTED/none) → source=none, revenue=null
        // Kept conservative: an unapproved estimate is a proposal,
        // not billable, so it doesn't inflate the lifetime totals.
        let source: HistoryEntry["source"] = "none";
        let revenue: number | null = null;
        let lines: Array<{ kind: string; description: string; qty: unknown; unitCost: unknown; lineTotal: unknown }> = [];
        if (invoice) {
            source = "invoice";
            revenue = Number(invoice.total);
            lines = invoice.lines;
        } else if (estimate && estimate.status === "APPROVED") {
            source = "estimate";
            revenue = Number(estimate.total);
            lines = estimate.lines;
        }

        // Cost = sum(qty * unitCost) across every line on the source.
        // Null when we have NO source (no invoice + no approved
        // estimate). Zero when the source exists but every line has
        // unitCost=0 — that's a real datum (a labour-only visit not
        // priced at cost), not "unknown".
        const cost: number | null = lines.length > 0
            ? lines.reduce((s, l) => s + Number(l.qty) * Number(l.unitCost ?? 0), 0)
            : (source === "none" ? null : 0);
        const margin: number | null = (revenue !== null && cost !== null)
            ? Number((revenue - cost).toFixed(2))
            : null;

        // Partial-payment sum ONLY when invoiced; estimates have no
        // payments. Outstanding = invoice.total − Σ payments.
        let outstanding: number | null = null;
        if (invoice) {
            const paid = invoice.payments.reduce((s, p) => s + Number(p.amount), 0);
            outstanding = Number((Number(invoice.total) - paid).toFixed(2));
        }

        const partsFitted = lines.filter((l) => l.kind === "PART").map((l) => l.description);
        const workDoneLines = lines.filter((l) => l.kind !== "PART").map((l) => l.description);

        return {
            jobCardId: j.id,
            jobNumber: j.number,
            date: j.createdAt,
            mileageIn: j.mileageIn,
            complaint: j.complaint,
            partsFitted,
            workDoneLines,
            status: j.status,
            ownerAtJobTime: ownerAtJobTime(j.createdAt),
            revenue,
            cost,
            margin,
            source,
            outstanding,
            invoiceNumber: invoice ? invoice.number : null,
            invoiceId: invoice ? invoice.id : null,
        };
    });

    const totals = {
        visits: entries.length,
        lifetimeRevenue: Number(entries.reduce((s, e) => s + (e.revenue ?? 0), 0).toFixed(2)),
        lifetimeCost: Number(entries.reduce((s, e) => s + (e.cost ?? 0), 0).toFixed(2)),
        lifetimeMargin: 0, // set below
        outstandingBalance: Number(entries.reduce((s, e) => s + (e.outstanding ?? 0), 0).toFixed(2)),
    };
    totals.lifetimeMargin = Number((totals.lifetimeRevenue - totals.lifetimeCost).toFixed(2));

    return {
        vehicle: {
            id: vehicle.id,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            plate: vehicle.plate,
            vin: vehicle.vin,
            engineSize: vehicle.engineSize,
            fuelType: vehicle.fuelType,
        },
        currentOwner,
        hasChangedHands: transfers.length > 0,
        transfers,
        entries,
        totals,
        garage: vehicle.customer.garage,
    };
}
