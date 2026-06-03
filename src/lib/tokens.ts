import { createHmac, timingSafeEqual } from "node:crypto";

// Signed capability tokens for public customer links (/c/estimate, /c/invoice).
// The link is `<id>~<hmac>`; tampering with the id invalidates the signature, and a
// token signed for one kind (estimate) can't be replayed against another (invoice).
function secret(): string {
  return process.env.AUTH_SECRET ?? "dev-only-insecure-secret";
}

export function signId(kind: string, id: string): string {
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
