import { NextRequest, NextResponse } from "next/server";

// AR 2026-08-25 Batch E — mismatch observability. The client posts one
// row per detected mismatch so we can inspect over the observation
// window whether the check fires only on genuine deploys or also on
// scale-ups / edge propagation events. `console.info` emits reach
// Vercel Logs; grep on the `[version-mismatch]` prefix.
//
// The banner itself is gated by NEXT_PUBLIC_VERSION_BANNER_ENABLED
// (default off); logging runs regardless so the observation window
// gets data even while the UI is silent.
//
// Body shape (client-defined, treated as untrusted):
//   { loadedId, currentId, url, userAgent }
// Any missing field renders as "(missing)" in the log line.
//
// No DB write, no rate-limit — one line per mismatch is cheap and a
// spike would itself be signal ("something is causing every tab to
// see mismatches"). If volume gets noisy we upgrade to a real
// aggregation surface.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface LogBody {
    loadedId?: unknown;
    currentId?: unknown;
    url?: unknown;
    userAgent?: unknown;
}

function coerce(v: unknown): string {
    if (typeof v !== "string") return "(missing)";
    if (v.length === 0) return "(empty)";
    // Cap to keep pathological payloads out of the log — we only ever
    // want short ids + URLs, not attacker-controlled multi-KB blobs.
    return v.length > 200 ? v.slice(0, 200) + "…" : v;
}

export async function POST(req: NextRequest) {
    let body: LogBody = {};
    try {
        body = (await req.json()) as LogBody;
    } catch {
        // Silent — a malformed POST is not worth alerting on. We still
        // emit one line so the noise pattern shows up if it repeats.
    }
    console.info(
        "[version-mismatch]",
        JSON.stringify({
            loadedId: coerce(body.loadedId),
            currentId: coerce(body.currentId),
            url: coerce(body.url),
            userAgent: coerce(body.userAgent),
        }),
    );
    return NextResponse.json({ ok: true }, { status: 200 });
}
