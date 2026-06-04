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
