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
    // DEV-ONLY: `prisma dev`'s own startup banner prescribes this client
    // config — max ~10 connections, connect timeout 0, and "idle timeout
    // set to the smallest positive value supported". Following it stops the
    // proxy's stale-socket kills (P1017 "Server has closed the connection")
    // that plague long dev sessions. Prod (Supabase pooler) keeps pg defaults.
    ...(isLocal
      ? { max: 10, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 0, keepAlive: true }
      : {}),
  });
}
