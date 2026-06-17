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

// Vehicle columns the app expects to find. Mirrors the Prisma model; if the
// live DB is missing any of these, the auto-applier below adds them. Same
// pattern as JobCard's expected-column list — kept hand-curated so a single
// route doubles as 'schema drift detector' + 'one-tap fixer'.
const EXPECTED_VEHICLE_COLUMNS = [
  "id",
  "customerId",
  "make",
  "model",
  "year",
  "plate",
  "vin",
  "engineSize",
  "fuelType",
  "createdAt",
  "updatedAt",
];

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

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return new NextResponse("Not authorized — please sign in first.\n", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  // ?apply=1 → actually run the ALTER statements for any JobCard
  // columns missing from the live DB. OWNER role only — we don't want
  // arbitrary signed-in users running schema changes. Idempotent: if
  // the column already exists, the SQL is skipped. This route exists
  // because AR has been trying to ALTER from the Supabase SQL editor
  // and it isn't taking effect (possibly wrong project) — running via
  // Prisma's connection guarantees we hit the same DB Prisma queries.
  const url = new URL(req.url);
  const wantsApply = url.searchParams.get("apply") === "1";
  const allowApply = wantsApply && session.user.role === "OWNER";

  const lines: string[] = [];
  lines.push("=== GarageOS DB schema diagnostic ===");
  if (wantsApply && !allowApply) {
    lines.push("⚠ apply=1 ignored: only OWNER role can apply schema changes.");
  }
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
      // ── Auto-apply path ─────────────────────────────────────────
      // Triggered by ?apply=1, OWNER role only. Runs the ALTER
      // statements via the same Prisma connection that detected the
      // missing columns, which guarantees we hit the actual DB the
      // app uses (and not a different Supabase project the user
      // might have opened in the SQL editor by mistake).
      if (allowApply) {
        lines.push("");
        lines.push("Applying via Prisma connection (apply=1):");
        for (const c of missing) {
          const type = guessType(c);
          // IF NOT EXISTS makes this re-runnable without conflict.
          const stmt = `ALTER TABLE "JobCard" ADD COLUMN IF NOT EXISTS "${c}" ${type}`;
          try {
            await prisma.$executeRawUnsafe(stmt);
            lines.push(`  ✓ added "${c}"`);
          } catch (e) {
            lines.push(
              `  ✗ FAILED "${c}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      } else if (!wantsApply) {
        lines.push("");
        lines.push("To apply automatically, OWNER can visit this URL with ?apply=1");
      }
    } else {
      lines.push("  ✓ all expected JobCard columns are present");
    }
  } catch (err) {
    lines.push(`JOBCARD COLUMNS QUERY FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Vehicle columns ──────────────────────────────────────────────
  // Same pattern as JobCard — list, diff, optionally ALTER. Added when
  // engineSize + fuelType moved onto Vehicle (intrinsic vehicle spec)
  // so the technician + parts pages can render "Toyota Prado · 2.7 ·
  // Petrol" without manual SQL ever leaving AR's Supabase tab.
  lines.push("");
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Vehicle'
        ORDER BY column_name`,
    )) as Array<{ column_name: string }>;
    const present = new Set(rows.map((r) => r.column_name));
    const missing = EXPECTED_VEHICLE_COLUMNS.filter((c) => !present.has(c));

    lines.push(`Vehicle columns: ${rows.length} present`);
    if (missing.length > 0) {
      lines.push("");
      lines.push("MISSING columns (need ALTER TABLE):");
      for (const c of missing) lines.push(`  ✗ ${c}`);
      lines.push("");
      lines.push("Generated ALTER TABLE statements to fix:");
      for (const c of missing) {
        lines.push(`  ALTER TABLE "Vehicle" ADD COLUMN "${c}" TEXT;`);
      }
      if (allowApply) {
        lines.push("");
        lines.push("Applying via Prisma connection (apply=1):");
        for (const c of missing) {
          const stmt = `ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "${c}" TEXT`;
          try {
            await prisma.$executeRawUnsafe(stmt);
            lines.push(`  ✓ added "${c}"`);
          } catch (e) {
            lines.push(
              `  ✗ FAILED "${c}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    } else {
      lines.push("  ✓ all expected Vehicle columns are present");
    }
  } catch (err) {
    lines.push(`VEHICLE COLUMNS QUERY FAILED: ${err instanceof Error ? err.message : String(err)}`);
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
