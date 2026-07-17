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
    // Pool sizing + idle behaviour.
    //
    // Local (`prisma dev` proxy): idleTimeoutMillis: 0 disposes each
    // socket the moment it returns to the pool. The dev proxy drops
    // idle sockets on its own schedule (interval undocumented — Prisma
    // does not publish it, and we've observed connections dying at
    // seemingly random gaps during the day). By never caching sockets
    // across requests we can't race that schedule: every render opens
    // a fresh TCP connection to the proxy. Trades one extra handshake
    // per request for zero P1017 "Server has closed the connection"
    // errors in dev. Was previously 1_000ms, which still raced.
    //
    // Prod (Supabase PgBouncer pooler): 10_000ms cache. Pooler holds
    // the real backend connection; our socket is to the PgBouncer
    // edge, which tolerates short idle. Tuned empirically. NOT
    // touching here.
    max: isLocal ? 4 : 3,
    idleTimeoutMillis: isLocal ? 0 : 10_000,
    // keepAlive: true — TODO(dev-adapter): this was originally added
    // expecting it would prevent peer-side idle drops. It doesn't —
    // `net.socket.setKeepAlive(true)` with no explicit initialDelay
    // uses the OS default (~7200s on Linux before the first probe),
    // which detects dead peers but does not prevent them from closing.
    // On the local path it's now redundant (idleTimeoutMillis: 0
    // disposes sockets before keepalive could ever fire). On the prod
    // path in serverless (short-lived containers) it's almost
    // certainly dead code too. Kept in this commit because the ask
    // was local-only; a separate commit should audit whether it earns
    // its place on prod before removing.
    keepAlive: true,
  });
}
