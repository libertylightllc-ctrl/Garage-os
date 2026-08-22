import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * Hydrate a quotation from a job's part requests (AR 2026-08-22
 * Batch 9). Owner types a JC# on /owner/purchasing/new, the client
 * calls this route, the response's `parts` seed the lines and the
 * `vehicle` block fills the doc-level default vehicle inputs. One
 * screen instead of two — a technician's requested parts are the
 * exact list a shop needs quoted, so this becomes the default path
 * (the estimate-line conversion at /owner/purchasing/from-estimate
 * stays as the priced-quote path).
 *
 * Contract:
 *   GET /api/jobs/by-number/{number}/part-requests
 *   → 200 {
 *       jobCardId: string,
 *       jobNumber: number,
 *       vehicle: { id, make, model, year, plate, vin, engineSize, fuelType } | null,
 *       parts: [{ description: string, qty: number, partId: string | null }],
 *     }
 *   → 400 non-integer / non-positive number
 *   → 401 not signed in
 *   → 403 signed in but not OWNER/MASTER
 *   → 404 no job with this number in this garage
 *          { error: "not-found", number: N }
 *
 * `parts` filters to statuses REQUESTED / ORDERED / ARRIVED — the
 * ones the shop still needs to source or track. FULFILLED means the
 * part was already fitted; CANCELLED means the tech withdrew the
 * request. Neither should show up on a fresh quotation.
 *
 * The response INTENTIONALLY separates "job exists but no open
 * requests" (200 with parts: []) from "job doesn't exist" (404). The
 * client renders different messaging for each — silently returning
 * an empty match on a bad JC# is exactly the failure the spec asked
 * us to eliminate.
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
            // Deliberately narrow status filter — see the block comment
            // above. Ordered ASC so the hydrated table reads in the
            // order the tech asked (matches the technician job page).
            partRequests: {
                where: { status: { in: ["REQUESTED", "ORDERED", "ARRIVED"] } },
                select: { description: true, qty: true, partId: true },
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
        parts: job.partRequests.map((p) => ({
            description: p.description,
            qty: p.qty,
            partId: p.partId,
        })),
    });
}
