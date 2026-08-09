import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * On-demand job-card-number → Vehicle lookup for the purchasing
 * vehicle picker. Parallel to /api/vehicles/by-plate but keyed off
 * JobCard.number instead of Vehicle.plate.
 *
 * Advisor use case: the operator already has the job card in front of
 * them — the JC# identifies both the car and the current work at
 * once. Typing "77" is faster than reading a plate off the dashboard
 * label. The lookup joins JobCard → Vehicle → Customer so we can
 * return the same shape the plate lookup does.
 *
 * Contract:
 *   GET /api/vehicles/by-job?number=N
 *   → 200 { match: { id, make, model, year, plate, vin, engineSize, fuelType, jobNumber } | null }
 *   → 400 missing / non-integer number
 *   → 401 not signed in
 *   → 403 signed in but not operational (OWNER / MASTER)
 *
 * Same garage-scoping rule as by-plate: the WHERE joins on
 * JobCard.garageId, so a job number that exists only in another
 * garage returns `match: null` — identical shape to "no such job
 * number anywhere," so nothing about another garage leaks through
 * the status code or response body.
 */
export async function GET(req: Request) {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    }
    if (!["OWNER", "MASTER"].includes(session.user.role)) {
        return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const url = new URL(req.url);
    const raw = (url.searchParams.get("number") ?? "").trim();
    if (!raw) {
        return NextResponse.json({ error: "Missing number" }, { status: 400 });
    }
    // JobCard.number is a per-garage sequential int. Reject non-integer
    // + non-positive input rather than silently returning null — a
    // negative or zero from a broken form is a bug worth surfacing.
    const number = Number.parseInt(raw, 10);
    if (!Number.isFinite(number) || number <= 0) {
        return NextResponse.json({ error: "Invalid number" }, { status: 400 });
    }

    const job = await prisma.jobCard.findFirst({
        where: { garageId: session.user.garageId, number },
        select: {
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
        },
    });

    if (!job) return NextResponse.json({ match: null });

    // Flatten to the same shape as /api/vehicles/by-plate, plus the
    // job number so the client can populate the operator's own
    // jobNumber input consistently (they may have typed just "7"
    // and we want to show "7" back, not overwrite it).
    return NextResponse.json({
        match: {
            id: job.vehicle.id,
            make: job.vehicle.make,
            model: job.vehicle.model,
            year: job.vehicle.year,
            plate: job.vehicle.plate,
            vin: job.vehicle.vin,
            engineSize: job.vehicle.engineSize,
            fuelType: job.vehicle.fuelType,
            jobNumber: job.number,
        },
    });
}
