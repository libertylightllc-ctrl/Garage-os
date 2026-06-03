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
