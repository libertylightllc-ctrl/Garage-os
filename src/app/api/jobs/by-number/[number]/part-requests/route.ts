import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * Hydrate a quotation from a job's parts-to-source list (AR
 * 2026-08-22 Batch 9, extended 2026-08-22 after JC-107 discovery).
 *
 * Two sources are surfaced together, in this order:
 *
 *   1. JobPart rows with kind IN (REQUIRED, EXTRA) — the "Technician
 *      findings & parts required" section on both the technician
 *      job page and the advisor's estimate editor. This is the
 *      COMMON case; the technician writes what the car needs
 *      straight into this list during diagnosis. See
 *      docs/Job-Card-Data-Model.md for the field.
 *
 *      Excluded here:
 *        - kind=USED    (already fitted; not for quoting)
 *
 *      NOT excluded even when estimateLineId is set: the advisor
 *      may have picked a catalog price without a fresh supplier
 *      quote; the shop may still want to re-quote. The operator
 *      can remove any hydrated row before submit.
 *
 *   2. PartRequest rows with status IN (REQUESTED, ORDERED,
 *      ARRIVED) — a distinct widget the tech uses less often, but
 *      it's the historical entry point and we still support it.
 *      FULFILLED (fitted) and CANCELLED (withdrawn) drop out for
 *      the same reason USED drops from JobPart.
 *
 * DEDUPLICATION
 * A part can appear in both sources (the tech typed it into
 * findings AND raised a request). The dedup key is:
 *   - partId when both sides have a partId and they match, else
 *   - trim(lowercase(description))
 * JobPart wins on collision — it carries the tech's canonical
 * wording; PartRequest is often re-typed from memory.
 *
 * FAILURE MODES (spec-required distinction)
 *   404 { error: "not-found" }  → JC# doesn't exist in this garage.
 *   200 { parts: [] }           → JC# exists but neither source has
 *                                 anything to quote right now.
 * The client renders different chips for each. Silent match:null
 * on a bad number was the exact failure the spec asked to
 * eliminate.
 *
 * Contract:
 *   GET /api/jobs/by-number/{number}/part-requests
 *   → 200 {
 *       jobCardId: string,
 *       jobNumber: number,
 *       vehicle: { id, make, model, year, plate, vin, engineSize, fuelType } | null,
 *       parts: [{
 *         description: string,
 *         qty: number,
 *         partId: string | null,
 *         source: "findings" | "request",
 *       }],
 *     }
 *   → 400 non-integer / non-positive number
 *   → 401 not signed in
 *   → 403 signed in but not OWNER/MASTER
 *   → 404 no job with this number in this garage
 *          { error: "not-found", number: N }
 *
 * Garage scoping: the WHERE joins on jobCard.garageId. A JC# that
 * exists only in another garage returns 404, byte-identical to "no
 * such job number anywhere" — nothing about another garage leaks
 * through the status code or response body.
 */
export async function GET(
    _req: Request,
    { params }: { params: Promise<{ number: string }> },
) {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    }
    if (!["OWNER", "MASTER"].includes(session.user.role)) {
        return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const { number: rawNumber } = await params;
    const trimmed = rawNumber.trim();
    if (!trimmed) {
        return NextResponse.json({ error: "Missing number" }, { status: 400 });
    }
    const number = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(number) || number <= 0) {
        return NextResponse.json({ error: "Invalid number" }, { status: 400 });
    }

    const job = await prisma.jobCard.findFirst({
        where: { garageId: session.user.garageId, number },
        select: {
            id: true,
            number: true,
            vehicle: {
                select: {
                    id: true,
                    make: true,
                    model: true,
                    year: true,
                    plate: true,
                    vin: true,
                    engineSize: true,
                    fuelType: true,
                },
            },
            // Source 1 — "Technician findings & parts required" list.
            // Ordered ASC so the hydrated table reads in the order
            // the tech wrote them (matches both the technician job
            // page and the estimate editor).
            jobParts: {
                where: { kind: { in: ["REQUIRED", "EXTRA"] } },
                select: {
                    description: true,
                    qty: true,
                    partId: true,
                },
                orderBy: { createdAt: "asc" },
            },
            // Source 2 — the separate PartRequest widget.
            partRequests: {
                where: { status: { in: ["REQUESTED", "ORDERED", "ARRIVED"] } },
                select: {
                    description: true,
                    qty: true,
                    partId: true,
                },
                orderBy: { createdAt: "asc" },
            },
        },
    });

    if (!job) {
        return NextResponse.json(
            { error: "not-found", number },
            { status: 404 },
        );
    }

    interface Hydrated {
        description: string;
        qty: number;
        partId: string | null;
        source: "findings" | "request";
    }
    const seen = new Map<string, Hydrated>();

    // Dedup key: partId when present, else normalised description.
    // Two rows with different partIds but the same description are
    // treated as distinct — the partId is authoritative when set
    // (different suppliers of the same brake pad, different sides
    // of the car, etc.).
    const keyFor = (row: { partId: string | null; description: string }) =>
        row.partId ? `p:${row.partId}` : `d:${row.description.trim().toLowerCase()}`;

    for (const j of job.jobParts) {
        const key = keyFor(j);
        if (!seen.has(key)) {
            seen.set(key, {
                description: j.description,
                qty: j.qty,
                partId: j.partId,
                source: "findings",
            });
        }
    }
    for (const r of job.partRequests) {
        const key = keyFor(r);
        // JobPart wins on collision — its wording is the tech's
        // authored text; PartRequest may be a re-type.
        if (!seen.has(key)) {
            seen.set(key, {
                description: r.description,
                qty: r.qty,
                partId: r.partId,
                source: "request",
            });
        }
    }

    return NextResponse.json({
        jobCardId: job.id,
        jobNumber: job.number,
        vehicle: job.vehicle
            ? {
                  id: job.vehicle.id,
                  make: job.vehicle.make,
                  model: job.vehicle.model,
                  year: job.vehicle.year,
                  plate: job.vehicle.plate,
                  vin: job.vehicle.vin,
                  engineSize: job.vehicle.engineSize,
                  fuelType: job.vehicle.fuelType,
              }
            : null,
        parts: [...seen.values()],
    });
}
