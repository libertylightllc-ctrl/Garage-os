import type { NextConfig } from "next";

// ─── Dev-server startup guard (2026-08-10) ─────────────────────────
//
// Refuse to boot `next dev` when the resolved DATABASE_URL points at a
// hosted Supabase DB. Belt-and-braces with the .env → PROD_DATABASE_URL
// rename: even if a future .env.local edit reintroduces a hosted URL
// (paste error, environment mix-up, a "let me just check prod" one-off),
// the dev server dies loudly before Next mounts a single route.
//
// This module is TOP-LEVEL of next.config.ts, so it runs at Next's own
// startup — before route handlers, middleware, Prisma client init. If
// the guard trips, the process exits and no request ever hits Prod.
//
// Gated on NODE_ENV === "development" so it can't accidentally break
// the Vercel build (which runs with NODE_ENV=production and a hosted
// DATABASE_URL by design). `next dev` sets NODE_ENV="development"; the
// build steps set "production".
if (process.env.NODE_ENV === "development") {
  const url = process.env.DATABASE_URL ?? "";
  if (url.includes("supabase.co") || url.includes("supabase.com")) {
    let host = "(unparseable)";
    try { host = new URL(url).host; } catch { /* leave placeholder */ }
    // Throw at config-load time. Next dumps the stack + exits.
    throw new Error(
      "\n" +
      "═══════════════════════════════════════════════════════════════\n" +
      `  ⚠  REFUSING TO BOOT DEV SERVER AGAINST HOSTED DB (${host})\n` +
      "═══════════════════════════════════════════════════════════════\n" +
      "\n" +
      "  A local `next dev` connected to a Supabase (Prod / Preview) DB is\n" +
      "  the exact accident that produced INV-2026-0039 (2026-08-09): a\n" +
      "  local test session wrote real customer rows to Prod, advanced\n" +
      "  the per-garage invoice sequence (gapless VAT-audit sequence), and\n" +
      "  fired a wa.me link signed with a non-Prod AUTH_SECRET.\n" +
      "\n" +
      "  Fix: restore .env.local so DATABASE_URL points at the local\n" +
      "  Prisma dev proxy (see AGENTS.md, canonical port triple\n" +
      "  51213 / 51214 / 51215). Then re-run `npm run dev`.\n" +
      "\n" +
      "  If you need to run an operator script against Prod, invoke that\n" +
      "  script directly (it opts in via scripts/lib/target-prod.mjs);\n" +
      "  don't route Prod through the dev server.\n",
    );
  }
}

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Photo uploads (Moulkia, check-in, tech, customer booking) flow through
      // Server Actions. Default is 1 MB — iPhone photos are 2–5 MB so every real
      // upload was failing with "Body exceeded 1 MB limit" (HTTP 413).
      //
      // Vercel Hobby caps the overall request body at 4.5 MB, so 4 MB leaves
      // headroom for multipart envelope overhead. Our client-side PhotoCapture
      // MAX_FILE_BYTES is set to the same 4 MB so the user gets a clean rejection
      // before the request leaves the phone.
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
