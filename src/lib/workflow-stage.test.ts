import { describe, it, expect } from "vitest";
import { workflowStage, WORKFLOW_STAGES } from "./workflow-stage";

describe("workflowStage", () => {
  it("ARRIVED → CHECK_IN (step 0)", () => {
    const s = workflowStage({ status: "ARRIVED" });
    expect(s.currentIndex).toBe(0);
    expect(WORKFLOW_STAGES[s.currentIndex]).toBe("CHECK_IN");
    expect(s.isCancelled).toBe(false);
  });

  it("INSPECTION → DIAGNOSIS (step 1)", () => {
    expect(workflowStage({ status: "INSPECTION" }).currentIndex).toBe(1);
  });

  it("ESTIMATE + DRAFT → ESTIMATE step (2)", () => {
    expect(
      workflowStage({ status: "ESTIMATE", latestEstimateStatus: "DRAFT" })
        .currentIndex,
    ).toBe(2);
  });

  it("ESTIMATE + SENT → APPROVAL step (3)", () => {
    expect(
      workflowStage({ status: "ESTIMATE", latestEstimateStatus: "SENT" })
        .currentIndex,
    ).toBe(3);
  });

  it("ESTIMATE + REJECTED → back to ESTIMATE step (2)", () => {
    // setEstimateStatusAction bounces the job back to ESTIMATE so the
    // cashier can re-price. Map that to the ESTIMATE step, not APPROVAL.
    expect(
      workflowStage({ status: "ESTIMATE", latestEstimateStatus: "REJECTED" })
        .currentIndex,
    ).toBe(2);
  });

  it("EXTRA_WORK_AWAITING_APPROVAL → APPROVAL step (3)", () => {
    // Tech found extras mid-repair; a revised quote is awaiting customer
    // sign-off — same UX as the original APPROVAL stage.
    expect(
      workflowStage({ status: "EXTRA_WORK_AWAITING_APPROVAL" }).currentIndex,
    ).toBe(3);
  });

  it("APPROVED / REPAIR → REPAIR step (4)", () => {
    expect(workflowStage({ status: "APPROVED" }).currentIndex).toBe(4);
    expect(workflowStage({ status: "REPAIR" }).currentIndex).toBe(4);
  });

  it("TECH_COMPLETE → COMPLETE step (5)", () => {
    expect(workflowStage({ status: "TECH_COMPLETE" }).currentIndex).toBe(5);
  });

  it("INVOICED unpaid → INVOICE step (6)", () => {
    expect(
      workflowStage({ status: "INVOICED", invoicePaid: false }).currentIndex,
    ).toBe(6);
  });

  it("INVOICED + paid → PAID ✓ done, DELIVERED is current (index 8)", () => {
    // Payment recorded means PAID is complete; the cashier's open work
    // is now the delivery stamp. Stepper renders PAID as ✓ green and
    // DELIVERED as ⏳ accent.
    expect(
      workflowStage({ status: "INVOICED", invoicePaid: true }).currentIndex,
    ).toBe(8);
  });

  it("DELIVERED → past-end (index 9, every step ✓)", () => {
    // Terminal state — no step should render as "current". Index lands
    // past the end of WORKFLOW_STAGES so the stepper's i < currentIndex
    // check marks every step done and i === currentIndex never matches.
    expect(workflowStage({ status: "DELIVERED" }).currentIndex).toBe(9);
  });

  it("CANCELLED → isCancelled flag set, currentIndex -1", () => {
    const s = workflowStage({ status: "CANCELLED" });
    expect(s.isCancelled).toBe(true);
    expect(s.currentIndex).toBe(-1);
  });

  it("ON_HOLD uses heldFrom to land on the right step", () => {
    // Paused waiting for a part during REPAIR → still sits at REPAIR
    // step (4), with the heldReason flag set so the UI shows a pill.
    const s = workflowStage({
      status: "ON_HOLD",
      heldFrom: "REPAIR",
      heldReason: "AWAITING_PART",
    });
    expect(s.currentIndex).toBe(4);
    expect(s.heldReason).toBe("AWAITING_PART");
  });

  it("ON_HOLD without heldFrom falls back to REPAIR (defensive)", () => {
    // Legacy rows / hand-edited data — never crash, surface the pill
    // and pin to REPAIR so the user at least sees something coherent.
    const s = workflowStage({ status: "ON_HOLD", heldReason: "OTHER" });
    expect(s.currentIndex).toBe(4);
    expect(s.heldReason).toBe("OTHER");
  });

  it("Unknown status defaults to CHECK_IN, doesn't throw", () => {
    expect(workflowStage({ status: "GARBAGE" }).currentIndex).toBe(0);
  });

  it("heldReason is null when not on hold", () => {
    expect(workflowStage({ status: "REPAIR" }).heldReason).toBeNull();
  });
});
