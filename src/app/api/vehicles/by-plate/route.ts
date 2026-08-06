import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * On-demand plate → Vehicle lookup for the purchasing forms.
 *
 * The add-line and doc-default vehicle widgets show a client-side
 * "matched garage record" chip when the plate the user typed matches
 * a Vehicle in this garage — and auto-fill the make/model/year/engine/
 * VIN inputs so the operator SEES exactly what the line will be saved
 * with (and can dismiss the match or edit any field before submit).
 *
 * We deliberately do NOT ship every garage vehicle's full record in
 * the page markup — that would put every plate + VIN in the HTML
 * source of a page that only needs one lookup per typed plate. This
 * route returns exactly one match, or null.
 *
 * Contract:
 *   GET /api/vehicles/by-plate?plate=X
 *   → 200 { match: { id, make, model, year, plate, vin, engineSize, fuelType } | null }
 *   → 400 missing plate query
 *   → 401 not signed in
 *   → 403 signed in but not an operational role (OWNER / MASTER)
 *
 * Cross-garage isolation: the WHERE clause always joins Vehicle.customer
 * against the caller's `garageId`. A plate that exists only in some
 * other garage returns `match: null` — the response shape is identical
 * to "no such plate anywhere," so nothing about another garage's data
 * leaks through the status code or body.
 *
 * The reason "no match" is a 200 (not a 404): the client needs to
 * distinguish `plate was typed but doesn't match a garage record`
 * (still valid — free-text) from a real transport error. A 404
 * would blur that with an infra fault.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }
  // Operational surfaces (purchasing + inventory + suppliers) are open
  // to OWNER + MASTER. Same guard as the actions that consume this
  // route's result — a signed-in advisor / cashier / tech shouldn't be
  // able to enumerate garage vehicles by plate.
  if (!["OWNER", "MASTER"].includes(session.user.role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const url = new URL(req.url);
  const rawPlate = (url.searchParams.get("plate") ?? "").trim();
  if (!rawPlate) {
    return NextResponse.json({ error: "Missing plate" }, { status: 400 });
  }

  const match = await prisma.vehicle.findFirst({
    where: {
      customer: { garageId: session.user.garageId },
      plate: { equals: rawPlate, mode: "insensitive" },
    },
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
  });

  return NextResponse.json({ match });
}
