import { prisma } from "@/lib/prisma";

// Supabase free-tier keepwarm — AR 2026-08-12 (split from /api/health).
//
// Contract: touch the DB, discard whatever came back, return HTTP 200.
// The Prisma call is the whole point — that's what keeps the Postgres
// connection pool from going cold. The RESPONSE deliberately carries
// nothing: no table list, no counts, no environment name. This
// endpoint is publicly reachable but response-blind, so hitting it
// tells the caller nothing beyond "the app can reach its database".
//
// Pinged by .github/workflows/keep-warm.yml every 5 minutes during
// UAE business hours. The workflow only cares about the status code —
// 200 means the DB is reachable, non-200 means it isn't. That's the
// entire signal.
//
// The rich diagnostic that used to be at /api/health (schema
// comparison, DB-vs-code drift) moved to /api/diagnose/db, which is
// auth-gated (see the DR runbook).
export async function GET() {
  try {
    // The query itself is the warming action. Result is intentionally
    // dropped on the floor — void assignment makes that explicit.
    void (await prisma.$queryRaw`SELECT 1`);
    return new Response("ok", { status: 200 });
  } catch {
    // DB unreachable. The keep-warm workflow will fail on this, which
    // is what should happen — Supabase asleep or migration mid-flight
    // is exactly what the operator needs to know about. No error
    // details in the body — the workflow surfaces the 500 by
    // status code alone.
    return new Response("db unreachable", { status: 500 });
  }
}
