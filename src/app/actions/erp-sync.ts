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
    const startAtStr = String(formData.get("startAt") ?? "").trim();
    let startAt: Date | undefined;
    if (startAtStr) {
        const parsed = new Date(startAtStr);
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
