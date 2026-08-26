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
  // @sparticuz/chromium ships its Chromium binary as loose files under
  // its own node_modules/@sparticuz/chromium/bin/ directory and reads
  // them at runtime via `executablePath()`. Turbopack's default
  // behavior bundles server dependencies, which strips those loose
  // files — the deploy layer ends up with the JS but no bin/, and
  // every PDF render throws:
  //   The input directory "/var/task/node_modules/@sparticuz/chromium/
  //   bin" does not exist.
  // (AR 2026-08-11, staff invoice PDF download.)
  //
  // Externalizing the package tells Next.js to leave it as a plain
  // node_modules require at runtime — Vercel then ships the full
  // package tree (including bin/) with the function bundle.
  //
  // puppeteer-core is externalized too, defensively: it's the loader
  // that reaches into @sparticuz/chromium's binary, and future puppeteer
  // versions may also ship native deps that don't survive bundling.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // Force Vercel's node-file-trace to include Chromium's loose binary
  // files under node_modules/@sparticuz/chromium/bin. Without this,
  // serverExternalPackages alone leaves the JS but drops bin/ (the
  // .tar.br binaries `executablePath()` extracts at cold start), and
  // every render throws:
  //   The input directory "/var/task/node_modules/@sparticuz/chromium/
  //   bin" does not exist.
  outputFileTracingIncludes: {
    "/api/invoices/**": [
      "./node_modules/@sparticuz/chromium/bin/**",
    ],
    "/c/invoice/**": [
      "./node_modules/@sparticuz/chromium/bin/**",
    ],
  },
  // AR 2026-08-25 Batch E — expose the git SHA to the client bundle so
  // <VersionCheck> can compare its snapshot-at-load against the current
  // deploy. Vercel injects VERCEL_GIT_COMMIT_SHA on every build; local
  // dev falls to "dev" (which never triggers a mismatch because both
  // client and server report the same value). NEXT_PUBLIC_* is inlined
  // at build time — the client sees whichever value was baked in.
  //
  // NEXT_PUBLIC_VERSION_BANNER_ENABLED is the ship-hidden gate: the
  // client keeps fetching /api/version and logging mismatches to
  // /api/version/log for observability, but the reload banner only
  // renders when this flag is "1". Set the Vercel env var to "1"
  // after a week of clean-log observation.
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
    NEXT_PUBLIC_VERSION_BANNER_ENABLED:
      process.env.VERSION_BANNER_ENABLED ?? "",
  },
  // AR 2026-08-26 — noindex on the customer document routes.
  // Signed opaque tokens make discovery cryptographically hard, but
  // one WhatsApp forward → screenshot → indexed URL = a customer's
  // TRN + invoice total + vehicle plate in Google. `noindex, nofollow`
  // on the response header is a belt-and-braces companion to the
  // per-page `<meta robots>` tag: either alone would suffice, both
  // together survive an edge proxy stripping one. Applied at the
  // whole /c/estimate/* and /c/invoice/* subtrees (which cover the
  // signed public estimate + invoice + PDF surfaces alike).
  async headers() {
    return [
      {
        source: "/c/estimate/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/c/invoice/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
  experimental: {
    // AR 2026-08-25 Batch E — kill App-Router client-cache staleness.
    // Next 16's default (dynamic: 30s) means a soft navigation between
    // routes can serve up to 30s of stale RSC. For a shop that leaves
    // the app open all day and navigates constantly, that's the
    // straight-line path to "advisor used last week's form because
    // Ctrl+F5 got the current page but not the router cache". 0 = every
    // soft navigation re-fetches from origin; static: 0 for the same
    // reason on public/static prefetches. Pin explicitly so a future
    // Next.js version raising the default can't silently reintroduce
    // the stale-navigation class.
    staleTimes: {
      dynamic: 0,
      static: 0,
    },
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
