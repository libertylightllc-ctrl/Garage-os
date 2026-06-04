// Technician claim eligibility (display/guard helper).
// NOTE: the real concurrency guarantee is the DB conditional UPDATE in claimJobAction
// (`updateMany WHERE claimedById IS NULL`), NOT this function — two simultaneous claims
// are serialized by the row lock so only one matches. This mirrors the predicate for the UI.

export interface ClaimableJob {
  status: string;
  claimedById: string | null;
  assignedToId: string | null;
}

const TERMINAL = ["DELIVERED", "CANCELLED"];

/** Is this job in the Waiting pool for `techId` (unclaimed, active, unassigned-or-mine)? */
export function canClaim(job: ClaimableJob, techId: string): boolean {
  if (job.claimedById !== null) return false;
  if (TERMINAL.includes(job.status)) return false;
  return job.assignedToId === null || job.assignedToId === techId;
}

export function isClaimedBy(job: ClaimableJob, techId: string): boolean {
  return job.claimedById === techId;
}

/**
 * May this technician log work on the job (Tier 2 #4 — primary + helpers)?
 * The primary claimer or any helper may; an unclaimed job is open (auto-claim on
 * first action). A job claimed by someone else is closed unless you're a helper.
 */
export function canLogWork(
  job: { claimedById: string | null },
  techId: string,
  helperIds: string[] = [],
): boolean {
  if (job.claimedById === null) return true; // unclaimed → first action claims it
  return job.claimedById === techId || helperIds.includes(techId);
}

/** Can this technician JOIN the job as a helper? (claimed by someone else, not already a helper) */
export function canJoinAsHelper(
  job: { status: string; claimedById: string | null },
  techId: string,
  helperIds: string[] = [],
): boolean {
  if (job.claimedById === null || job.claimedById === techId) return false;
  if (TERMINAL.includes(job.status)) return false;
  return !helperIds.includes(techId);
}
