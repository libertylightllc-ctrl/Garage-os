// Owner-side actions for the ERPNext sync operator surface.
//
// Guards are strict-owner. ERPNext sync sits alongside billing +
// analytics + ledger on the OWNER-only side of the master/owner
// boundary — finance concerns, not operational floor. See
// src/lib/__tests__/master-owner-boundary.test.ts.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/action-guards";
import { prisma } from "@/lib/prisma";
import {
    enableErpSyncForGarage,
    disableErpSyncForGarage,
} from "@/lib/erp-sync/enable";

export async function enableErpSyncAction(formData: FormData) {
    const user = await requireOwner();
    // AR 2026-08-27 — only honour startAt when the operator
    // explicitly ticks "Backfill from a past date". A bare
    // datetime-local picker silently carries autofilled or
    // leftover values (same trap the terms field had), and one
    // slipped through: the Demo Garage cursor got seeded a week
    // back and the tailer sat idle waiting for a scheduler that
    // didn't exist. Checkbox first — picker only meaningful if
    // ticked — is the guard.
    const backfillOn = String(formData.get("backfill") ?? "") === "1";
    let startAt: Date | undefined;
    if (backfillOn) {
        const startAtStr = String(formData.get("startAt") ?? "").trim();
        if (!startAtStr) {
            redirect("/owner/erp?err=bad-startat");
        }
        // datetime-local sends `YYYY-MM-DDTHH:mm` (no TZ, no seconds).
        // Server is UTC; interpret as UTC by appending "Z" so what
        // the operator typed is what gets stored. If they wanted a
        // different timezone they'd have to say so — hint text on
        // the field carries that.
        const isoUtc = startAtStr.endsWith("Z") ? startAtStr : `${startAtStr}Z`;
        const parsed = new Date(isoUtc);
        if (Number.isNaN(parsed.getTime())) {
            redirect("/owner/erp?err=bad-startat");
        }
        startAt = parsed;
    }
    await enableErpSyncForGarage({ garageId: user.garageId, startAt });
    revalidatePath("/owner/erp");
    redirect("/owner/erp");
}

export async function disableErpSyncAction() {
    const user = await requireOwner();
    await disableErpSyncForGarage({ garageId: user.garageId });
    revalidatePath("/owner/erp");
    redirect("/owner/erp");
}

/**
 * Replay a FAILED or DEAD_LETTER job. Resets to PENDING and clears
 * attempts + lastError so the next runner pass tries fresh. The
 * pre-flight check in the pusher makes this safe even if the prior
 * attempt landed a POST on ERPNext side.
 */
export async function replayErpSyncJobAction(formData: FormData) {
    const user = await requireOwner();
    const jobId = String(formData.get("jobId") ?? "").trim();
    if (!jobId) {
        redirect("/owner/erp?err=no-job");
    }
    const job = await prisma.erpSyncJob.findFirst({
        where: { id: jobId, garageId: user.garageId },
        select: { id: true, status: true },
    });
    if (!job) {
        // Silently redirect — not-found on someone else's garage or a
        // deleted job.
        redirect("/owner/erp?err=not-found");
    }
    if (job.status !== "FAILED" && job.status !== "DEAD_LETTER") {
        // Idempotent — replaying a PENDING/RUNNING/SYNCED job is a
        // no-op with a hint.
        redirect(`/owner/erp?err=not-replayable&status=${job.status}`);
    }
    await prisma.erpSyncJob.update({
        where: { id: jobId },
        data: {
            status: "PENDING",
            attempts: 0,
            lastError: null,
            lastErrorField: null,
        },
    });
    revalidatePath("/owner/erp");
    redirect("/owner/erp");
}

/**
 * Reset the tailer cursor to "now" for this garage. Wipes the
 * current cursor row and creates a fresh one at new Date() — so
 * the tailer will pick up only ledger rows created FROM THIS
 * MOMENT FORWARD.
 *
 * Motivated by the 2026-08-27 incident: the /owner/erp
 * datetime-local input silently sent a stale value, and the cursor
 * ended up seeded a week back. Deleting the row from Prisma Studio
 * was a real recovery path; this action turns it into a button.
 *
 * SAFE because sync remains ON and the cursor comes back
 * immediately — the tailer's missing-cursor skip window is one
 * transaction long. If sync was OFF at reset time we still leave
 * the flag OFF; operator flips it separately.
 */
export async function resetErpSyncCursorAction() {
    const user = await requireOwner();
    await prisma.$transaction(async (tx) => {
        await tx.erpSyncCursor.deleteMany({
            where: { garageId: user.garageId },
        });
        await tx.erpSyncCursor.create({
            data: {
                garageId: user.garageId,
                lastLedgerCreatedAt: new Date(),
                lastLedgerId: "",
            },
        });
        // AR 2026-08-28 (finding #3): reset must also clear
        // already-queued PENDING jobs. Otherwise "reset to now"
        // leaves the pre-reset backlog draining and the two
        // states disagree — the cursor says "start from now" but
        // the runner keeps pushing week-old rows.
        //
        // SYNCED / FAILED / DEAD_LETTER / RUNNING rows are kept
        // deliberately: SYNCED is history and load-bearing on the
        // entity-map join, FAILED / DEAD_LETTER are operator
        // decisions the reset should not undo, and RUNNING is
        // literally in flight — deleting it mid-push corrupts the
        // pusher's atomic commit.
        await tx.erpSyncJob.deleteMany({
            where: { garageId: user.garageId, status: "PENDING" },
        });
    });
    revalidatePath("/owner/erp");
    redirect("/owner/erp");
}
