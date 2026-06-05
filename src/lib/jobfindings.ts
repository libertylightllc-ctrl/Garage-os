// Technician Findings & Parts Required (Job-Card-Data-Model.md). Pure helpers so the
// submit gate, status advance, and qty handling are testable.

/** Findings need actual text before they can be submitted to the cashier. */
export function canSubmitFindings(finding: { findings?: string | null } | null | undefined): boolean {
  return !!finding?.findings && finding.findings.trim().length > 0;
}

/**
 * Submitting findings hands the job to the cashier. Advance to ESTIMATE only from an
 * early stage — never override later stages or an ON_HOLD (the advisor still controls
 * status from the timeline).
 */
export function nextStatusAfterFindings(status: string): string {
  return status === "ARRIVED" || status === "INSPECTION" ? "ESTIMATE" : status;
}

/** A part line needs at least a positive quantity. */
export function cleanQty(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.trunc(n));
}

/**
 * The repair section (work notes + parts used) is editable once the work is
 * authorised (an approved estimate exists) and until the tech marks it complete.
 */
export function repairUnlocked(
  hasApprovedEstimate: boolean,
  workCompletedAt: Date | null | undefined,
): boolean {
  return hasApprovedEstimate && !workCompletedAt;
}
