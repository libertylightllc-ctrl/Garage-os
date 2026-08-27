/**
 * ERPNext sync runner — HTTP endpoint.
 *
 * SCHEDULER: .github/workflows/erp-tailer.yml pings this route
 * every 5 minutes as the second step after the tailer ping. The
 * workflow's name is legacy from when it only pinged the tailer;
 * it now handles both routes. If you rename or delete this file,
 * also remove the runner ping step in the workflow — otherwise
 * the ping fires against nothing. NOT wired to Vercel crons
 * (plan cron-slot cap — see vercel.json.NOTES.md).
 *
 * For each garage with erpSyncEnabled = true, invokes runOnePass().
 * Aggregates results into a summary line + JSON response.
 *
 * Auth mirrors the two existing cron routes (ai-credit-check,
 * auto-close-stale-sessions).
 *
 * Greppable log shape (AR 2026-08-27):
 *   [erp-runner] SKIPPED garage=<id> reason=missing-credentials envs=<list>
 *   [erp-runner] PRE_FLIGHT_HIT garage=<id> op=<op> sourceId=<id> erpnextName=<n>
 *   [erp-runner] FAILED garage=<id> op=<op> sourceId=<id> attempts=<n> err=<msg>
 *   [erp-runner] DEAD_LETTER garage=<id> op=<op> sourceId=<id> attempts=<n> err=<msg>
 *   [erp-runner] summary garages=N synced=X preflight_hits=Y failed=Z blocked=B ...
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runOnePass, type RunnerPassResult } from "@/lib/erp-sync/runner";

export async function GET(req: Request): Promise<Response> {
    const secret = process.env.CRON_SECRET;
    const authRequired = Boolean(secret);
    const authHeader = req.headers.get("authorization") ?? "";
    const authOk = !secret || authHeader === `Bearer ${secret}`;

    console.log(
        `[erp-runner] invoked at=${new Date().toISOString()} authRequired=${authRequired} authOk=${authOk}`,
    );

    if (secret && !authOk) {
        console.warn(
            `[erp-runner] 401 — no matching Authorization; bearer sent=${authHeader.startsWith("Bearer ")}`,
        );
        return new NextResponse("unauthorized", { status: 401 });
    }

    const enabled = await prisma.garage.findMany({
        where: { erpSyncEnabled: true },
        select: { id: true },
    });

    if (enabled.length === 0) {
        console.log(`[erp-runner] summary garages=0 (no garage has erpSyncEnabled=true)`);
        return NextResponse.json({
            garages: 0,
            processed: 0,
            synced: 0,
            preflightHits: 0,
            failed: 0,
            deadLettered: 0,
            blocked: 0,
            skippedNotImplemented: 0,
            skippedMissingCredentials: 0,
            skippedGarageIds: [],
            results: [],
        });
    }

    const results: RunnerPassResult[] = [];
    for (const g of enabled) {
        try {
            results.push(await runOnePass(g.id, prisma));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[erp-runner] ERROR garage=${g.id} ${msg}`);
        }
    }

    const advanced = results.filter((r) => r.status === "advanced");
    const skippedCreds = results.filter((r) => r.status === "skipped-missing-credentials");
    const totalSynced = advanced.reduce((n, r) => n + r.synced, 0);
    const totalPreflight = advanced.reduce((n, r) => n + r.preflightHits, 0);
    const totalFailed = advanced.reduce((n, r) => n + r.failed, 0);
    const totalDead = advanced.reduce((n, r) => n + r.deadLettered, 0);
    const totalBlocked = advanced.reduce((n, r) => n + r.blocked, 0);
    const totalSkippedNI = advanced.reduce((n, r) => n + r.skippedNotImplemented, 0);
    const totalProcessed = advanced.reduce((n, r) => n + r.processed, 0);

    console.log(
        `[erp-runner] summary garages=${enabled.length} processed=${totalProcessed} synced=${totalSynced} preflight_hits=${totalPreflight} failed=${totalFailed} dead=${totalDead} blocked=${totalBlocked} not_implemented=${totalSkippedNI} skipped_creds=${skippedCreds.length}`,
    );

    return NextResponse.json({
        garages: enabled.length,
        processed: totalProcessed,
        synced: totalSynced,
        preflightHits: totalPreflight,
        failed: totalFailed,
        deadLettered: totalDead,
        blocked: totalBlocked,
        skippedNotImplemented: totalSkippedNI,
        skippedMissingCredentials: skippedCreds.length,
        skippedGarageIds: skippedCreds.map((s) => s.garageId),
        results,
    });
}
