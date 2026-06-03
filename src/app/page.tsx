import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function Home() {
  let status: { ok: boolean; tables?: number; garages?: number; error?: string };
  try {
    const [tables, garages] = await Promise.all([
      prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public';`,
      prisma.garage.count(),
    ]);
    status = { ok: true, tables: Number(tables[0]?.n ?? 0), garages };
  } catch (err) {
    status = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">GarageOS</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Phase 1 MVP · UAE · WhatsApp-first · AI proposes, humans confirm
        </p>
      </div>

      <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="mb-2 text-sm font-medium">System status</h2>
        {status.ok ? (
          <ul className="space-y-1 text-sm">
            <li>🟢 Database connected</li>
            <li>🟢 Schema applied — {status.tables} tables</li>
            <li>🔵 Garages seeded: {status.garages}</li>
          </ul>
        ) : (
          <p className="text-sm text-red-600">🔴 DB error: {status.error}</p>
        )}
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Build step 1 complete: scaffold + Prisma schema + DB. Next: auth + 4 staff role screens.
      </p>
    </main>
  );
}
