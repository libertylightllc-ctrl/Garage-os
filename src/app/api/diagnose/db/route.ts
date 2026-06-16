import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * Diagnostic: list live DB columns for tables we know about, so we
 * can pinpoint schema-vs-DB drift without depending on the user being
 * able to copy a hidden error.digest off a red error page.
 *
 * Plain-text response so even a phone browser can render it cleanly.
 * Auth-gated to any signed-in user (any role) — it doesn't reveal
 * row data, only the schema shape.
 *
 * Compares actual columns to a hand-curated 'expected' list. The
 * expected list mirrors what the Prisma client SELECTs by default
 * for each table, so anything 'expected' but not 'present' is the
 * exact column that needs an ALTER TABLE.
 */

const EXPECTED_TABLES = [
  "JobCard",
  "Vehicle",
  "Customer",
  "Invoice",
  "InvoiceLine",
  "Payment",
  "Estimate",
  "EstimateLine",
  "JobFinding",
  "JobStep",
  "JobPart",
  "JobHelper",
  "PartRequest",
  "Part",
  "Reminder",
  "Bay",
  "AdvancePayment",
] as const;

const EXPECTED_JOBCARD_COLUMNS = [
  "id",
  "garageId",
  "vehicleId",
  "advisorId",
  "bookingId",
  "status",
  "heldFrom",
  "holdReason",
  "holdNote",
  "assignedToId",
  "claimedById",
  "claimedAt",
  "sentForEstimateAt",
  "sentForReestimateAt",
  "priority",
  "bayId",
  "number",
  "mileageIn",
  "oilType",
  "fuelType",
  "fuelLevel",
  "complaint",
  "exteriorCondition",
  "exteriorRemarks",
  "interiorCondition",
  "interiorRemarks",
  "valuables",
  "valuablesNote",
  "moulkiaConsentAt",
  "workNotes",
  "workCompletedAt",
  "invoiceSentAt",
  "qcChecks",
  "qcById",
  "qcAt",
  "mileageOut",
  "deliveredById",
  "deliveredAt",
  "deliveryConfirmedAt",
  "createdAt",
  "updatedAt",
];

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return new NextResponse("Not authorized — please sign in first.\n", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const lines: string[] = [];
  lines.push("=== GarageOS DB schema diagnostic ===");
  lines.push("");

  // ── Which tables exist ────────────────────────────────────────────
  let presentTables: Set<string>;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
      EXPECTED_TABLES as readonly string[],
    )) as Array<{ table_name: string }>;
    presentTables = new Set(rows.map((r) => r.table_name));
  } catch (err) {
    lines.push(`TABLE QUERY FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return new NextResponse(lines.join("\n") + "\n", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  lines.push("Tables expected by the app:");
  for (const t of EXPECTED_TABLES) {
    const mark = presentTables.has(t) ? "✓" : "✗ MISSING";
    lines.push(`  ${mark}  ${t}`);
  }
  lines.push("");

  // ── JobCard columns ───────────────────────────────────────────────
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'JobCard'
        ORDER BY column_name`,
    )) as Array<{ column_name: string }>;
    const present = new Set(rows.map((r) => r.column_name));
    const missing = EXPECTED_JOBCARD_COLUMNS.filter((c) => !present.has(c));

    lines.push(`JobCard columns: ${rows.length} present`);
    if (missing.length > 0) {
      lines.push("");
      lines.push("MISSING columns (need ALTER TABLE):");
      for (const c of missing) lines.push(`  ✗ ${c}`);
      lines.push("");
      lines.push("Generated ALTER TABLE statements to fix:");
      for (const c of missing) {
        const type = guessType(c);
        lines.push(`  ALTER TABLE "JobCard" ADD COLUMN "${c}" ${type};`);
      }
    } else {
      lines.push("  ✓ all expected JobCard columns are present");
    }
  } catch (err) {
    lines.push(`JOBCARD COLUMNS QUERY FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Best-guess SQL type for a missing column so the suggested ALTER
 * is copy-paste runnable. Doesn't try to be exhaustive; covers the
 * shape of columns in JobCard.
 */
function guessType(name: string): string {
  if (name.endsWith("At")) return "TIMESTAMP(3)";
  if (name === "exteriorCondition" || name === "interiorCondition" || name === "valuables" || name === "qcChecks")
    return 'TEXT[] NOT NULL DEFAULT \'{}\'';
  if (name === "mileageIn" || name === "mileageOut" || name === "number" || name === "priority")
    return "INTEGER";
  if (name === "fuelLevel") return '"FuelLevel"';
  if (name === "oilType") return '"OilType" NOT NULL DEFAULT \'NONE\'';
  if (name === "holdReason") return '"HoldReason"';
  return "TEXT";
}
