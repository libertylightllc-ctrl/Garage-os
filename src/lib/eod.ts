// End-of-day open-jobs view (Workflow-Spec Tier 3 #12). Pure bucketing so the
// "what's unfinished / waiting / ready" grouping is testable.

export type EodBucket =
  | "IN_PROGRESS"
  | "WAITING_PARTS"
  | "WAITING_CUSTOMER"
  | "READY"
  | "OTHER";

/** Which end-of-day bucket a job falls into, from its status + hold reason. */
export function eodBucket(status: string, holdReason: string | null | undefined): EodBucket {
  if (status === "INVOICED") return "READY"; // done & invoiced, not yet collected
  if (status === "ON_HOLD") {
    if (holdReason === "AWAITING_PART") return "WAITING_PARTS";
    if (holdReason === "AWAITING_CUSTOMER" || holdReason === "AWAITING_APPROVAL") {
      return "WAITING_CUSTOMER";
    }
    return "OTHER";
  }
  return "IN_PROGRESS";
}

export const EOD_BUCKETS: EodBucket[] = [
  "IN_PROGRESS",
  "WAITING_PARTS",
  "WAITING_CUSTOMER",
  "READY",
  "OTHER",
];
