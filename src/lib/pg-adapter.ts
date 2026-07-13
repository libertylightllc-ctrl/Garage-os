import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Builds the Prisma pg driver adapter with the right SSL handling.
 * - Local Prisma Postgres (sslmode=disable / localhost): no SSL.
 * - Supabase / remote: encrypt but don't verify the chain. The pooler presents a
 *   self-signed chain that Node's default CAs reject; `pg` now treats sslmode=require
 *   as strict verify-full, so we relax verification here. (Acceptable for a pooled
 *   managed DB; tighten with the Supabase CA cert if stricter verification is needed.)
 */
export function makePgAdapter() {
  const url = process.env.DATABASE_URL ?? "";
  const isLocal = url.includes("localhost") || url.includes("sslmode=disable");
  return new PrismaPg({
    connectionString: url,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    // Both the local `prisma dev` proxy AND Supabase's PgBouncer pooler
    // drop idle sockets (P1017 "Server has closed the connection").
    // Small pool + short idle timeout + keepAlive prevents stale
    // connections from causing "Something went wrong" errors.
    max: isLocal ? 4 : 3,
    idleTimeoutMillis: isLocal ? 1_000 : 10_000,
    keepAlive: true,
  });
}
