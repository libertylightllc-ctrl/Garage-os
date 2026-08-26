/**
 * ERPNext sync tailer — cron endpoint.
 *
 * Runs every 5 minutes (see vercel.json). For each garage with
 * erpSyncEnabled = true, invokes runTailer(). Aggregates the results
 * into a summary line + JSON response.
 *
 * Auth: mirrors the two existing cron routes (ai-credit-check,
 * auto-close-stale-sessions). If CRON_SECRET is set (Vercel
 * provisions this automatically for cron paths), require the
 * matching Bearer. If unset, allow unauthenticated GETs so an
 * operator can hit the endpoint by hand during initial setup.
 *
 * Missing-cursor skip: an enabled garage without an ErpSyncCursor
 * row gets logged loudly with a greppable prefix
 * `[erp-tailer] SKIPPED garage=<id> reason=missing-cursor` — this
 * is almost always someone flipping erpSyncEnabled directly in
 * the database rather than via enableErpSyncForGarage(). The count
 * also lands in the summary line and the JSON response so the
 * anomaly is visible without having to grep logs.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runTailer, type TailerResult } from "@/lib/erp-sync/tailer";

export async function GET(req: Request): Promise<Response> {
    const secret = process.env.CRON_SECRET;
    const authRequired = Boolean(secret);
    const authHeader = req.headers.get("authorization") ?? "";
    const authOk = !secret || authHeader === `Bearer ${secret}`;

    console.log(
        `[erp-tailer] invoked at=${new Date().toISOString()} authRequired=${authRequired} authOk=${authOk}`,
    );

    if (secret && !authOk) {
        console.warn(
            `[erp-tailer] 401 — no matching Authorization; bearer sent=${authHeader.startsWith("Bearer ")}`,
        );
        return new NextResponse("unauthorized", { status: 401 });
    }

    const enabled = await prisma.garage.findMany({
        where: { erpSyncEnabled: true },
        select: { id: true },
    });

    // Empty case: nothing enabled anywhere. Emit one line so log
    // greps for `[erp-tailer]` can differentiate "cron fired and did
    // nothing because no garage is on" from "cron never fired".
    if (enabled.length === 0) {
        console.log(`[erp-tailer] summary garages=0 (no garage has erpSyncEnabled=true)`);
        return NextResponse.json({
            garages: 0,
            enqueued: 0,
            scanned: 0,
            advanced: 0,
            quiet: 0,
            skippedMissingCursor: 0,
            skippedGarageIds: [],
            results: [],
        });
    }

    const results: TailerResult[] = [];
    for (const g of enabled) {
        try {
            results.push(await runTailer(g.id, prisma));
        } catch (err) {
            // A tailer error on ONE garage must not stop other
            // garages from syncing this pass. Log with the offending
            // garage id — Phase 3's runner will pick up any partial
            // work already enqueued.
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[erp-tailer] ERROR garage=${g.id} ${msg}`);
        }
    }

    const advanced = results.filter((r) => r.status === "advanced");
    const quiet = results.filter((r) => r.status === "quiet");
    const skipped = results.filter((r) => r.status === "skipped-missing-cursor");
    const totalEnqueued = advanced.reduce((n, r) => n + r.enqueued, 0);
    const totalScanned = advanced.reduce((n, r) => n + r.scanned, 0);

    // Greppable per-skip lines. One line per skipped garage — noisy
    // enough to notice, capped by the number of enabled garages
    // (there is no per-pass amplification because a missing cursor
    // is a one-shot condition per garage until enable is re-run).
    // Names the fix so ops doesn't have to grep the codebase.
    for (const s of skipped) {
        console.warn(
            `[erp-tailer] SKIPPED garage=${s.garageId} reason=missing-cursor — flip via enableErpSyncForGarage() or scripts/erp-enable-garage.mts`,
        );
    }

    console.log(
        `[erp-tailer] summary garages=${enabled.length} advanced=${advanced.length} quiet=${quiet.length} skipped=${skipped.length} enqueued=${totalEnqueued} scanned=${totalScanned}`,
    );

    return NextResponse.json({
        garages: enabled.length,
        enqueued: totalEnqueued,
        scanned: totalScanned,
        advanced: advanced.length,
        quiet: quiet.length,
        skippedMissingCursor: skipped.length,
        skippedGarageIds: skipped.map((s) => s.garageId),
        results,
    });
}
