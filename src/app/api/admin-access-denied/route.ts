import { NextRequest } from "next/server";
import { logAdminAccess } from "@/lib/admin-audit";

// Internal endpoint reached only via src/middleware.ts rewrite. The
// browser sees a 404 (URL stays at the original /admin/* path); we
// write one access_denied row to AdminAuditLog with the original path
// and the request's IP/UA captured by logAdminAccess.
//
// This route is also directly fetchable — any client could `curl
// /api/admin-access-denied?path=/anywhere` and trigger a log row. That's
// acceptable: the route can ONLY produce DENY rows (no admin scope, no
// data leak), and the bad-actor cost is one DB row per request. If
// spamming becomes a real issue, add IP-based rate-limiting here; not
// in Phase 2.
//
// Force Node runtime — Prisma's pg adapter needs Node net sockets.
export const runtime = "nodejs";

async function handle(req: NextRequest): Promise<Response> {
  const path =
    req.headers.get("x-admin-deny-path") ??
    req.nextUrl.searchParams.get("path") ??
    "<unknown>";
  await logAdminAccess({
    actorAdminId: null,
    action: "access_denied",
    meta: { reason: "no_session", path },
  });
  return new Response(null, { status: 404 });
}

export const GET = handle;
export const POST = handle;
