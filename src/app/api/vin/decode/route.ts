import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { normalizeVin, nhtsaFuelToInternal } from "@/lib/jobcard-fields";

/**
 * Server-side NHTSA VIN decode — slice intake-vin.
 *
 * Why server-side: NHTSA's vpic.nhtsa.dot.gov endpoint sometimes has
 * slow responses and rate-limit shape that's awkward to handle from
 * the browser. Doing it server-side gives us:
 *   - One consistent timeout (8s)
 *   - The ability to add caching later without a client refactor
 *   - Auth gate: only signed-in staff can hit this — no public abuse
 *
 * Endpoint shape (kept simple):
 *   POST /api/vin/decode  { "vin": "1HGCM82633A004352" }
 *   →  200 { make, model, year, fuelType, engine, raw }
 *   →  400 invalid VIN
 *   →  401 not signed in
 *   →  502 NHTSA error / timeout
 *
 * The client component is responsible for the OCR-friendly merge
 * (don't overwrite typed values with blank NHTSA results) — this
 * route just returns what NHTSA gave us, normalized.
 */

interface NhtsaResultRow {
  Make?: string;
  Model?: string;
  ModelYear?: string;
  FuelTypePrimary?: string;
  EngineModel?: string;
  EngineCylinders?: string;
  DisplacementL?: string;
  ErrorCode?: string;
  ErrorText?: string;
}

const NHTSA_TIMEOUT_MS = 8000;

function emptyToNull(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  // NHTSA returns 'Not Applicable' for unmapped slots; treat as empty
  // so the caller doesn't try to fill the field with the literal
  // string "Not Applicable".
  if (!s || /^not applicable$/i.test(s) || s === "0") return null;
  return s;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  let body: { vin?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const vin = normalizeVin(String(body.vin ?? ""));
  if (!vin) {
    return NextResponse.json(
      { error: "VIN must be 17 alphanumeric characters (no I, O, or Q)" },
      { status: 400 },
    );
  }

  // AbortController gives us a hard timeout — without it, a slow
  // NHTSA response would hang the route and the user's intake form.
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), NHTSA_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${vin}?format=json`,
      { signal: ctrl.signal },
    );
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error && err.name === "AbortError" ? "timeout" : "network";
    console.warn("[vin-decode] fetch failed", msg);
    return NextResponse.json({ error: `NHTSA ${msg}` }, { status: 502 });
  }
  clearTimeout(timeout);

  if (!resp.ok) {
    return NextResponse.json({ error: `NHTSA HTTP ${resp.status}` }, { status: 502 });
  }
  const json = (await resp.json()) as { Results?: NhtsaResultRow[] };
  const row = json.Results?.[0];
  if (!row) {
    return NextResponse.json({ error: "Empty NHTSA response" }, { status: 502 });
  }

  // NHTSA's ErrorCode is a comma-separated list of numeric codes.
  // "0" means success. Anything else is at least partial-failure;
  // we still return whatever fields ARE populated (NHTSA frequently
  // returns partial data for GCC-spec vehicles — make/model OK but
  // fuel type empty). The CLIENT decides whether to fill blanks.
  // engineSize — DisplacementL is the canonical liters value (e.g. "2.7",
  // "4.0"). NHTSA sometimes returns trailing zeros ("2.70000") which look
  // ugly in the input; trim them down so the field shows the same way a
  // human would write it. Stored as a free-text string on Vehicle so this
  // value round-trips cleanly.
  const engineSize = (() => {
    const raw = emptyToNull(row.DisplacementL);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    // Drop trailing zeros: 2.7 not 2.7000; 4 not 4.0000. parseFloat-toString
    // is the simplest path but loses 4.0 → "4"; for engine size, "2.7" /
    // "4.0" both read naturally to a mechanic so we keep one decimal when
    // it's a whole number, otherwise trust the parsed value.
    if (Number.isInteger(n)) return `${n}.0`;
    return String(n);
  })();

  const result = {
    vin,
    make: emptyToNull(row.Make),
    model: emptyToNull(row.Model),
    year: emptyToNull(row.ModelYear),
    fuelType: nhtsaFuelToInternal(row.FuelTypePrimary),
    engineSize,
    engine: [
      emptyToNull(row.EngineModel),
      emptyToNull(row.EngineCylinders) && `${row.EngineCylinders} cyl`,
      emptyToNull(row.DisplacementL) && `${row.DisplacementL} L`,
    ]
      .filter(Boolean)
      .join(" · ") || null,
    errorCode: row.ErrorCode ?? null,
    errorText: row.ErrorText ?? null,
  };
  return NextResponse.json(result);
}
