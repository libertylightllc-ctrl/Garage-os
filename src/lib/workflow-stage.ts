// Pure helper that maps the job's real workflow state (status + most-
// recent-estimate + invoice paid-ness) onto the 9-step user-facing
// stepper. Derive on every render — never persist a "stage" column,
// because every input that drives the answer can change without us
// remembering to migrate a denormalised column.

export const WORKFLOW_STAGES = [
  "CHECK_IN",
  "DIAGNOSIS",
  "ESTIMATE",
  "APPROVAL",
  "REPAIR",
  "COMPLETE",
  "INVOICE",
  "PAID",
  "DELIVERED",
] as const;

export type WorkflowStageKey = (typeof WORKFLOW_STAGES)[number];

export interface WorkflowState {
  /** Index into WORKFLOW_STAGES. -1 when the job is CANCELLED (the
   *  stepper still renders, but every step shows as muted). */
  currentIndex: number;
  /** True when the job is CANCELLED — the UI shows a banner alongside
   *  the muted stepper rather than highlighting a current stage. */
  isCancelled: boolean;
  /** Hold reason if the job is ON_HOLD — drives a small "paused" pill
   *  next to the current step. Null when not on hold. */
  heldReason: string | null;
}

export interface WorkflowInput {
  /** JobCard.status */
  status: string;
  /** JobCard.heldFrom — original stage if status === "ON_HOLD". Lets the
   *  stepper land on the right pre-hold step instead of guessing. */
  heldFrom?: string | null;
  /** JobCard.holdReason — drives the "paused for parts / approval" pill. */
  heldReason?: string | null;
  /** Most recent Estimate.status (DRAFT / SENT / APPROVED / REJECTED) or
   *  null when no estimate exists yet. Used to split job.status=ESTIMATE
   *  between the ESTIMATE step (DRAFT prep) and APPROVAL step (SENT). */
  latestEstimateStatus?: string | null;
  /** True iff the latest invoice has been fully paid (balance ≤ 0). Used
   *  to advance from INVOICE → PAID when status is INVOICED. */
  invoicePaid?: boolean;
}

/** Map a workflow state to the canonical 9-step stepper index. */
export function workflowStage(input: WorkflowInput): WorkflowState {
  const {
    status,
    heldFrom,
    heldReason,
    latestEstimateStatus,
    invoicePaid,
  } = input;

  if (status === "CANCELLED") {
    return { currentIndex: -1, isCancelled: true, heldReason: null };
  }

  // ON_HOLD is a wrapper — the user-visible stage is whatever the job
  // was on before being paused. Fall back to REPAIR if heldFrom is
  // missing (legacy data); the "paused" pill will still flag it.
  const effective = status === "ON_HOLD" ? heldFrom ?? "REPAIR" : status;

  let currentIndex = 0;
  switch (effective) {
    case "ARRIVED":
      currentIndex = 0; // CHECK_IN
      break;
    case "INSPECTION":
      currentIndex = 1; // DIAGNOSIS
      break;
    case "ESTIMATE":
      // The job sits at ESTIMATE while the cashier is preparing the
      // quote (estimate DRAFT) AND while the customer reviews it
      // (estimate SENT). Split the two on the estimate's own status.
      // REJECTED bounces back to DRAFT prep → ESTIMATE step.
      currentIndex = latestEstimateStatus === "SENT" ? 3 /* APPROVAL */ : 2 /* ESTIMATE */;
      break;
    case "EXTRA_WORK_AWAITING_APPROVAL":
      currentIndex = 3; // APPROVAL — re-quote awaiting customer reply
      break;
    case "APPROVED":
    case "REPAIR":
      currentIndex = 4; // REPAIR — customer approved, tech is working
      break;
    case "TECH_COMPLETE":
      currentIndex = 5; // COMPLETE — tech tapped Mark Complete
      break;
    case "INVOICED":
      // Invoice issued. Once paid, the cashier's work on this row is
      // DONE — the only remaining step is the customer collecting the
      // car, which is the DELIVERED stamp. So PAID renders as ✓ and
      // DELIVERED becomes the current step. While the invoice is still
      // unpaid the cashier sits at INVOICE waiting to record payment.
      currentIndex = invoicePaid ? 8 /* DELIVERED is current */ : 6 /* INVOICE */;
      break;
    case "DELIVERED":
      // Terminal state — every step including DELIVERED is done. Land
      // past the end of the stage list so no step renders as "current"
      // and the whole bar shows ✓. The stepper renders i < currentIndex
      // as completed; with currentIndex = WORKFLOW_STAGES.length, all
      // 9 steps satisfy that.
      currentIndex = 9;
      break;
    default:
      currentIndex = 0;
  }

  return {
    currentIndex,
    isCancelled: false,
    heldReason: status === "ON_HOLD" ? heldReason ?? null : null,
  };
}
