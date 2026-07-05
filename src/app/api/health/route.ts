import { prisma } from "@/lib/prisma";

// Proves the full stack: Next route handler -> Prisma -> Postgres.
export async function GET() {
  try {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name;`;
    const garageCount = await prisma.garage.count();
    return Response.json({
      ok: true,
      db: "connected",
      tableCount: rows.length,
      tables: rows.map((r) => r.table_name),
      garageCount,
      // Boolean status ONLY — never the key value. Lets us confirm whether
      // vision OCR (Moulkia + the upcoming invoice import) runs for real in
      // an environment, or silently falls back to mock data.
      ocr: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
