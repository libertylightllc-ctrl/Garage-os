import { NextRequest, NextResponse } from "next/server";

// Defence-in-depth for /admin/*. The real gate is requireAdmin() in
// every server component / server action; middleware just deflects
// unauthenticated noise so /admin paths look like they don't exist
// (404, not a redirect to /login — see admin-auth.ts for why).
//
// This middleware does NOT validate JWT contents — it only checks
// "is there a session cookie at all." Cookie presence proves nothing
// (the JWT could be a regular staff token, or expired, or for someone
// who isn't an admin) — that's why requireAdmin() does the real work.
//
// /admin/login is exempt — it has to be reachable without a session
// for an admin to sign in.
//
// Phase 2: anonymous /admin/* probes are rewritten to a Node-runtime
// API route that writes an "access_denied" row to AdminAuditLog and
// returns 404. Middleware itself runs in the edge runtime where Prisma
// can't reach a Postgres socket, so the API-route hop is how we get
// the row in.

const SESSION_COOKIE_NAMES = [
  "authjs.session-token",            // dev / HTTP
  "__Secure-authjs.session-token",   // prod / HTTPS
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Login page itself is open
  if (pathname === "/admin/login") return NextResponse.next();

  // Everything else under /admin/* requires a session cookie of some
  // kind. If none present, rewrite to the audit-logging 404 endpoint.
  // The browser URL stays /admin/<whatever> (a real redirect would
  // advertise our paths); the response body + status come from the
  // rewritten handler.
  const hasSession = SESSION_COOKIE_NAMES.some((c) => req.cookies.has(c));
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/api/admin-access-denied";
    url.search = ""; // strip any inbound query params before rewriting
    url.searchParams.set("path", pathname);
    // Belt-and-braces: also pass the original path as a request header,
    // since some Next.js rewrite paths strip query strings during the
    // proxy hop. Whichever the handler sees wins.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-admin-deny-path", pathname);
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  return NextResponse.next();
}

export const config = {
  // Run only on /admin/*. Cheap to add the matcher than the alternative
  // (running on every request and short-circuiting at the top).
  matcher: ["/admin/:path*"],
};
