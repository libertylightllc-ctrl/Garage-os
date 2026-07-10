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
    // DEV-ONLY: the local `prisma dev` proxy drops sockets under bursts of
    // concurrent connection handshakes and after long sessions (P1017
    // "Server has closed the connection"). A SMALL pool serializes the
    // handshake bursts (queries queue instead of opening 8+ sockets at
    // once) and a short idle timeout recycles sockets before the proxy
    // kills them — the banner's "idle timeout at the smallest positive
    // value" advice. Prod (Supabase pooler) keeps pg defaults.
    ...(isLocal ? { max: 4, idleTimeoutMillis: 1_000, keepAlive: true } : {}),
  });
}
