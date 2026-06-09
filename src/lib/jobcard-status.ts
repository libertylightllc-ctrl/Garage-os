// JobCard state machine for the Service Advisor timeline.
// Pure + dependency-free so transitions are exhaustively testable.

export type JobStatus =
  | "ARRIVED"
  | "INSPECTION"
  | "ESTIMATE"
  | "APPROVED"
  | "REPAIR"
  | "INVOICED"
  | "DELIVERED"
  | "ON_HOLD"
  | "CANCELLED";

// The linear advisor timeline (one tap advances by one).
export const TIMELINE: JobStatus[] = [
  "ARRIVED",
  "INSPECTION",
  "ESTIMATE",
  "APPROVED",
  "REPAIR",
  "INVOICED",
  "DELIVERED",
];

export type JobAction = "ADVANCE" | "HOLD" | "RESUME" | "CANCEL" | "REWORK";

export const STATUS_LABEL: Record<JobStatus, string> = {
  ARRIVED: "Arrived",
  INSPECTION: "Inspection",
  ESTIMATE: "Estimate",
  APPROVED: "Approved",
  REPAIR: "Repair",
  INVOICED: "Invoiced",
  DELIVERED: "Delivered",
  ON_HOLD: "On hold",
  CANCELLED: "Cancelled",
};

// ---- Customer/staff-friendly status ----------------------------------------
//
// The internal JobStatus is a state-machine token; everyone reading a job
// (advisor, tech, cashier, owner) needs a single human-readable phrase
// describing the current handoff stage. friendlyStatus() collapses the
// internal model into the six labels the workflow spec asks for, plus the
// honest 'on hold' and 'cancelled' edge states.

export type FriendlyStatus =
  | "WAITING_FOR_TECH"
  | "TECH_DIAGNOSING"
  | "ESTIMATE_UNDER_PROCESS"
  | "AWAITING_CUSTOMER_APPROVAL"
  | "APPROVED_IN_PROGRESS"
  | "COMPLETE"
  | "ON_HOLD"
  | "CANCELLED";

/** What we need from the job to compute its friendly status. */
export interface FriendlyStatusInput {
  status: JobStatus;
  claimedById: string | null;
  /** Status of the most recent estimate, if one exists. */
  latestEstimateStatus?: "DRAFT" | "SENT" | "APPROVED" | "REJECTED" | null;
}

/**
 * Collapse the internal JobStatus + claim/estimate context into the six
 * customer-friendly labels (plus ON_HOLD / CANCELLED).
 *
 *   internal               → friendly
 *   ─────────────────────── ──────────────────────────────
 *   ARRIVED, no claim      → WAITING_FOR_TECH
 *   ARRIVED, claimed       → TECH_DIAGNOSING   (claimed but pre-INSPECTION)
 *   INSPECTION             → TECH_DIAGNOSING
 *   ESTIMATE, no SENT yet  → ESTIMATE_UNDER_PROCESS
 *   ESTIMATE, latest=SENT  → AWAITING_CUSTOMER_APPROVAL
 *   APPROVED/REPAIR/INVOICED→ APPROVED_IN_PROGRESS
 *   DELIVERED              → COMPLETE
 *   ON_HOLD                → ON_HOLD
 *   CANCELLED              → CANCELLED
 */
export function friendlyStatus(input: FriendlyStatusInput): FriendlyStatus {
  switch (input.status) {
    case "ARRIVED":
      return input.claimedById ? "TECH_DIAGNOSING" : "WAITING_FOR_TECH";
    case "INSPECTION":
      return "TECH_DIAGNOSING";
    case "ESTIMATE":
      return input.latestEstimateStatus === "SENT"
        ? "AWAITING_CUSTOMER_APPROVAL"
        : "ESTIMATE_UNDER_PROCESS";
    case "APPROVED":
    case "REPAIR":
    case "INVOICED":
      return "APPROVED_IN_PROGRESS";
    case "DELIVERED":
      return "COMPLETE";
    case "ON_HOLD":
      return "ON_HOLD";
    case "CANCELLED":
      return "CANCELLED";
  }
}

/**
 * Tailwind tone for the friendly status badge. Kept as a small data table
 * so colours stay consistent everywhere the badge renders.
 *   bg / text classes for both light and dark mode.
 */
export const FRIENDLY_STATUS_TONE: Record<FriendlyStatus, string> = {
  WAITING_FOR_TECH:
    "bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  TECH_DIAGNOSING:
    "bg-blue-100 text-blue-900 dark:bg-blue-950/60 dark:text-blue-200",
  ESTIMATE_UNDER_PROCESS:
    "bg-violet-100 text-violet-900 dark:bg-violet-950/60 dark:text-violet-200",
  AWAITING_CUSTOMER_APPROVAL:
    "bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200",
  APPROVED_IN_PROGRESS:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200",
  COMPLETE:
    "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  ON_HOLD:
    "bg-yellow-100 text-yellow-900 dark:bg-yellow-950/60 dark:text-yellow-200",
  CANCELLED:
    "bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200",
};

export function isLinear(s: JobStatus): boolean {
  return TIMELINE.includes(s);
}

export function isTerminal(s: JobStatus): boolean {
  return s === "DELIVERED" || s === "CANCELLED";
}

export function isActive(s: JobStatus): boolean {
  return !isTerminal(s);
}

/** Next linear stage, or null if at the end / not on the linear path. */
export function nextStatus(s: JobStatus): JobStatus | null {
  const i = TIMELINE.indexOf(s);
  if (i === -1 || i === TIMELINE.length - 1) return null;
  return TIMELINE[i + 1];
}

// Rework (e.g. estimate rejected, extra work found) sends these stages back to ESTIMATE.
const REWORKABLE: JobStatus[] = ["APPROVED", "REPAIR"];

export interface JobState {
  status: JobStatus;
  heldFrom: JobStatus | null;
}

/** Action types that are valid from the current state. UI lays these out (max 3 on screen). */
export function availableActions(state: JobState): JobAction[] {
  const { status } = state;
  if (status === "ON_HOLD") return ["RESUME", "CANCEL"];
  if (isTerminal(status)) return [];
  // active linear stage
  const actions: JobAction[] = [];
  if (nextStatus(status)) actions.push("ADVANCE");
  if (REWORKABLE.includes(status)) actions.push("REWORK");
  actions.push("HOLD", "CANCEL");
  return actions;
}

// Advisor override: forward stages an active job may jump to. INVOICED/DELIVERED are
// excluded — those are reached via the real invoice flow / a normal advance, not a skip.
export function skippableTargets(current: JobStatus): JobStatus[] {
  if (!isLinear(current)) return [];
  const i = TIMELINE.indexOf(current);
  return TIMELINE.slice(i + 1).filter((s) => s !== "INVOICED" && s !== "DELIVERED");
}

export function skipTo(state: JobState, target: JobStatus): JobState {
  if (!skippableTargets(state.status).includes(target)) {
    throw new Error(`Cannot skip from ${state.status} to ${target}`);
  }
  return { status: target, heldFrom: null };
}

/** Apply an action; returns the new state or throws on an invalid transition. */
export function transition(state: JobState, action: JobAction): JobState {
  const { status, heldFrom } = state;

  switch (action) {
    case "ADVANCE": {
      const next = nextStatus(status);
      if (!next) throw new Error(`Cannot advance from ${status}`);
      return { status: next, heldFrom: null };
    }
    case "HOLD": {
      if (!isLinear(status)) throw new Error(`Cannot hold from ${status}`);
      return { status: "ON_HOLD", heldFrom: status };
    }
    case "RESUME": {
      if (status !== "ON_HOLD") throw new Error(`Cannot resume from ${status}`);
      return { status: heldFrom ?? "ARRIVED", heldFrom: null };
    }
    case "REWORK": {
      if (!REWORKABLE.includes(status)) throw new Error(`Cannot rework from ${status}`);
      return { status: "ESTIMATE", heldFrom: null };
    }
    case "CANCEL": {
      if (isTerminal(status)) throw new Error(`Cannot cancel from ${status}`);
      return { status: "CANCELLED", heldFrom: null };
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
}
