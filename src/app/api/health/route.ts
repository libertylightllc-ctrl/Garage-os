// Public liveness probe — AR 2026-08-12.
//
// Reachable from any client on any origin. Returns exactly one thing:
// HTTP 200 + the string "ok". No JSON, no version, no commit SHA, no
// DB shape, no environment name — because whoever's watching this URL
// gets ONE bit of information out of it. Anything else is
// reconnaissance material handed out for free.
//
// The DB-touching diagnostic that used to live here has moved to
// /api/keepwarm (public but response-blind) for the Supabase warming
// job, and /api/diagnose/db (auth-gated) for the schema comparison
// the DR runbook uses.
export function GET() {
  return new Response("ok", { status: 200 });
}
