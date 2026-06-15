// JobCard state machine for the Service Advisor timeline.
// Pure + dependency-free so transitions are exhaustively testable.

export type JobStatus =
  | "ARRIVED"
  | "INSPECTION"
  | "ESTIMATE"
  | "APPROVED"
  | "REPAIR"
  | "EXTRA_WORK_AWAITING_APPROVAL" // tech tapped 'Send for Re-estimate'; awaiting cashier+customer
  | "TECH_COMPLETE" // tech tapped 'Mark complete', waiting on cashier to send invoice
  | "INVOICED"
  | "DELIVERED"
  | "ON_HOLD"
  | "CANCELLED";

// The linear advisor timeline (one tap advances by one). TECH_COMPLETE sits
// between REPAIR and INVOICED so a normal forward tap walks through it.
export const TIMELINE: JobStatus[] = [
  "ARRIVED",
  "INSPECTION",
  "ESTIMATE",
  "APPROVED",
  "REPAIR",
  "TECH_COMPLETE",
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
  EXTRA_WORK_AWAITING_APPROVAL: "Extra work — awaiting approval",
  TECH_COMPLETE: "Tech complete",
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
  | "EXTRA_WORK_AWAITING_APPROVAL" // tech found extra problems mid-job; new estimate cycle is running
  | "COMPLETE_AWAITING_INVOICE"
  | "AWAITING_PAYMENT"
  | "READY_FOR_PICKUP"
  | "COMPLETE"
  | "ON_HOLD"
  | "CANCELLED";

/** What we need from the job to compute its friendly status. */
export interface FriendlyStatusInput {
  status: JobStatus;
  claimedById: string | null;
  /** Status of the most recent estimate, if one exists. */
  latestEstimateStatus?: "DRAFT" | "SENT" | "APPROVED" | "REJECTED" | null;
  /**
   * Whether the latest invoice on this job has been paid in full.
   * Drives the AWAITING_PAYMENT → READY_FOR_PICKUP transition for
   * INVOICED-status jobs.
   */
  invoicePaidInFull?: boolean;
}

/**
 * Collapse the internal JobStatus + claim/estimate context into the
 * customer-friendly labels (the 11 spec stages mapped onto fewer pills
 * where stages share a status, plus ON_HOLD / CANCELLED).
 *
 *   internal                 → friendly
 *   ─────────────────────────── ──────────────────────────────
 *   ARRIVED, no claim        → WAITING_FOR_TECH         (Stage 2)
 *   ARRIVED, claimed         → TECH_DIAGNOSING          (Stage 3 — gap before INSPECTION)
 *   INSPECTION               → TECH_DIAGNOSING          (Stage 3)
 *   ESTIMATE, no SENT yet    → ESTIMATE_UNDER_PROCESS   (Stages 4+5)
 *   ESTIMATE, latest=SENT    → AWAITING_CUSTOMER_APPROVAL (Stage 6)
 *   APPROVED                 → APPROVED_IN_PROGRESS     (Stage 7 start)
 *   REPAIR                   → APPROVED_IN_PROGRESS     (Stage 7 work)
 *   TECH_COMPLETE            → COMPLETE_AWAITING_INVOICE (Stage 8)
 *   INVOICED, not paid       → AWAITING_PAYMENT          (Stage 9)
 *   INVOICED, paid in full   → READY_FOR_PICKUP          (Stage 10)
 *   DELIVERED                → COMPLETE                  (Stage 11)
 *   ON_HOLD                  → ON_HOLD                   (kept honest)
 *   CANCELLED                → CANCELLED                 (kept honest)
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
      return "APPROVED_IN_PROGRESS";
    case "EXTRA_WORK_AWAITING_APPROVAL":
      return "EXTRA_WORK_AWAITING_APPROVAL";
    case "TECH_COMPLETE":
      return "COMPLETE_AWAITING_INVOICE";
    case "INVOICED":
      return input.invoicePaidInFull ? "READY_FOR_PICKUP" : "AWAITING_PAYMENT";
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
// Visual polish C2: mapped to the Workshop 4-tone semantic palette.
// Every status that means 'waiting on someone' uses warning (amber).
// Every status that means 'in progress / informational' uses info (blue).
// Success (green) reserved for completed / approved / paid states.
// Danger (red) for problem states (re-estimate awaiting approval, on hold).
// Neutral (zinc) for terminal/cancelled.
export const FRIENDLY_STATUS_TONE: Record<FriendlyStatus, string> = {
  WAITING_FOR_TECH:
    "bg-warning-50 text-warning-600 dark:bg-warning-500/10 dark:text-warning-500",
  TECH_DIAGNOSING:
    "bg-info-50 text-info-600 dark:bg-info-500/10 dark:text-info-500",
  ESTIMATE_UNDER_PROCESS:
    "bg-info-50 text-info-600 dark:bg-info-500/10 dark:text-info-500",
  AWAITING_CUSTOMER_APPROVAL:
    "bg-warning-50 text-warning-600 dark:bg-warning-500/10 dark:text-warning-500",
  APPROVED_IN_PROGRESS:
    "bg-success-50 text-success-700 dark:bg-success-500/10 dark:text-success-500",
  EXTRA_WORK_AWAITING_APPROVAL:
    "bg-danger-50 text-danger-700 dark:bg-danger-500/10 dark:text-danger-500",
  COMPLETE_AWAITING_INVOICE:
    "bg-info-50 text-info-600 dark:bg-info-500/10 dark:text-info-500",
  AWAITING_PAYMENT:
    "bg-warning-50 text-warning-600 dark:bg-warning-500/10 dark:text-warning-500",
  READY_FOR_PICKUP:
    "bg-info-50 text-info-600 dark:bg-info-500/10 dark:text-info-500",
  COMPLETE:
    "bg-success-50 text-success-700 dark:bg-success-500/10 dark:text-success-500",
  ON_HOLD:
    "bg-danger-50 text-danger-700 dark:bg-danger-500/10 dark:text-danger-500",
  CANCELLED:
    "bg-neutral-100 text-neutral-700 dark:bg-surface-2 dark:text-text-mute",
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
  // Exclude INVOICED + DELIVERED (those are reached via the real invoice
  // flow / collection confirm, not a skip) AND TECH_COMPLETE (Stage 7→8
  // is the tech's explicit Mark-complete tap; advisor must not bypass it).
  return TIMELINE.slice(i + 1).filter(
    (s) => s !== "INVOICED" && s !== "DELIVERED" && s !== "TECH_COMPLETE",
  );
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
