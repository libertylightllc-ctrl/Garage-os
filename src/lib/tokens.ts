import { createHmac, timingSafeEqual } from "node:crypto";

// Signed capability tokens for public customer links (/c/estimate, /c/invoice).
// The link is `<id>~<hmac>`; tampering with the id invalidates the signature, and a
// token signed for one kind (estimate) can't be replayed against another (invoice).
const DEV_FALLBACK_SECRET = "dev-only-insecure-secret";

function secret(): string {
  return process.env.AUTH_SECRET ?? DEV_FALLBACK_SECRET;
}

// Heuristic: DATABASE_URL points at a Supabase-hosted DB. Our prod + preview
// DBs both live there; local dev uses the Prisma dev proxy on localhost.
// Combined with the dev fallback secret this catches the specific accident
// where a local `npm run dev` inherits the repo-root `.env` (which points
// DATABASE_URL at the Supabase pooler for operator scripts, per AGENTS.md)
// but has no AUTH_SECRET — the dev fallback then signs URLs that will never
// verify on the real Vercel Prod deploy. Diagnosed 2026-08-10 on INV-2026-0039:
// a demo-tenant test send hand-signed a wa.me link with the dev fallback
// while pointing at the Prod DB; token failed on tap. This guard makes the
// failure LOUD at send time instead of shipping a dead link.
function looksLikeHostedDb(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return url.includes("supabase.co") || url.includes("supabase.com");
}

export function signId(kind: string, id: string): string {
  if (secret() === DEV_FALLBACK_SECRET && looksLikeHostedDb()) {
    throw new Error(
      "signId: refusing to sign with the dev fallback secret while DATABASE_URL " +
      "points at a hosted (Supabase) DB. The token would never verify on that " +
      "environment. Set AUTH_SECRET in your local env, or point DATABASE_URL " +
      "at the local Prisma dev proxy.",
    );
  }
  const sig = createHmac("sha256", secret()).update(`${kind}:${id}`).digest("base64url").slice(0, 24);
  return `${id}~${sig}`;
}

export function verifyToken(kind: string, token: string): string | null {
  const i = token.lastIndexOf("~");
  if (i <= 0) return null;
  const id = token.slice(0, i);
  const expected = signId(kind, id);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? id : null;
}
