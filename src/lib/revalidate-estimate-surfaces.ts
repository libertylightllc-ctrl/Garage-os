// Central revalidation set for every action that mutates an
// Estimate's status. Duplicating this list per-writer is exactly
// how the 2026-08-27 "advisor Mark approved does nothing" bug
// shipped: the customer-facing approve path called the full set;
// the advisor-side setEstimateStatusAction did not, and
// /advisor/estimates + /cashier kept serving cached RSC saying
// SENT after the DB flipped to APPROVED.
//
// Every future writer that touches Estimate.status or the
// corresponding JobCard.status transition MUST call this.
//
// AR 2026-08-18 (customer-side origin) + 2026-08-28 (advisor-side
// gap fix).

import { revalidatePath } from "next/cache";

export function revalidateEstimateStaffSurfaces(
    jobCardId: string,
    estimateId: string,
): void {
    // Job detail — estimate status pill + workflow step marker read here.
    revalidatePath(`/advisor/jobs/${jobCardId}`);
    // Staff estimate edit page — line state + totals + status.
    revalidatePath(`/estimates/${estimateId}`);
    // Advisor home / jobs board — status counts on the dashboard.
    revalidatePath("/advisor");
    // Advisor estimates board — DRAFT/SENT/APPROVED/REJECTED buckets.
    revalidatePath("/advisor/estimates");
    // Cashier dashboard — Ready-for-Invoice bucket, aggregate
    // counters. Approving an estimate can flip a job into a state
    // the cashier cares about.
    revalidatePath("/cashier");
}
