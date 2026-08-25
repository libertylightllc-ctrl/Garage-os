import { NextResponse } from "next/server";

// AR 2026-08-25 Batch E — build-id echo. The client's <VersionCheck>
// snapshots NEXT_PUBLIC_BUILD_ID at module load (baked into the
// bundle at Vercel build time) and polls this endpoint on focus and
// on a slow interval. If the returned id differs from the snapshot,
// the client bundle is older than the current deploy — either the
// user has been sitting on the page across a deploy, or their tab
// restored from bfcache with a stale runtime.
//
// force-dynamic + no-store: this endpoint must always hit origin and
// must never be served from any cache — a cached response would
// defeat the entire mechanism (the client would keep seeing its own
// old buildId in the response).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
    const buildId = process.env.VERCEL_GIT_COMMIT_SHA ?? "dev";
    return NextResponse.json(
        { buildId },
        {
            headers: {
                "Cache-Control": "no-store, must-revalidate",
            },
        },
    );
}
